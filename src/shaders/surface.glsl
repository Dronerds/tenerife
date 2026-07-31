/**
 * Biome classification and procedural surface detail.
 *
 * SECOND HALF OF A CONTRACT with `src/procedural/surface.ts`. Change one, change
 * both; `test/noise-parity.test.ts` asserts they agree.
 *
 * This is where realism at 15 m AGL actually comes from. The heightfield is
 * posted every 30 m, so it supplies the shape of the island and nothing else —
 * every feature smaller than a DEM cell is synthesised here, deterministically
 * from world position.
 *
 * Requires noise.glsl.
 */

// Biome ids. Must match BIOME in src/procedural/surface.ts.
const int TNRF_BIOME_SEA = 0;
const int TNRF_BIOME_COASTAL_ARID = 1;
const int TNRF_BIOME_CULTIVATED = 2;
const int TNRF_BIOME_LAURISILVA = 3;
const int TNRF_BIOME_PINE = 4;
const int TNRF_BIOME_RETAMA = 5;
const int TNRF_BIOME_LAVA = 6;
const int TNRF_BIOME_URBAN = 7;

// Compacted WorldCover classes. Must match COVER in src/geo/landcover.ts.
const int TNRF_COVER_WATER = 0;
const int TNRF_COVER_TREES = 1;
const int TNRF_COVER_SHRUB = 2;
const int TNRF_COVER_GRASS = 3;
const int TNRF_COVER_CROPLAND = 4;
const int TNRF_COVER_BUILT = 5;
const int TNRF_COVER_BARE = 6;
const int TNRF_COVER_SNOW = 7;

/**
 * Tenerife's altitudinal vegetation banding.
 *
 * The island is a textbook case: bands are sharp, well documented, and strongly
 * aspect-dependent. The trade winds hit the north side, so the wet laurisilva
 * belt exists only on north-facing slopes between roughly 400 and 1200 m — the
 * same altitudes on the southern side are arid scrub. Elevation alone gets this
 * badly wrong, which is why aspect is an input.
 *
 * `wetness` is 1 on north-facing slopes and 0 on south-facing.
 */
int tnrf_biome(vec2 worldXZ, float elevation, float slope, float wetness, int cover) {
  if (elevation < 1.0 || cover == TNRF_COVER_WATER) return TNRF_BIOME_SEA;

  // Observed cover wins where it is unambiguous. Elevation rules cannot know
  // where a town is, and Tenerife's coastal strip is heavily built up — guessing
  // "arid scrub" over Puerto de la Cruz was the largest single error in the
  // previous elevation-only classification.
  if (cover == TNRF_COVER_BUILT) return TNRF_BIOME_URBAN;
  if (cover == TNRF_COVER_CROPLAND) return TNRF_BIOME_CULTIVATED;

  // Bare rock wherever it is too steep to hold soil, at any altitude — the sea
  // cliffs of Los Gigantes and the walls of every barranco.
  if (slope > 0.72) return TNRF_BIOME_LAVA;
  if (cover == TNRF_COVER_BARE || cover == TNRF_COVER_SNOW) return TNRF_BIOME_LAVA;

  // Perturb the elevation used for the remaining thresholds.
  //
  // Without this, every boundary is an exact iso-contour of a 30 m DEM, which
  // reads as a hard stepped edge following the cell grid. A slow large-scale
  // noise turns each boundary into a ragged transition hundreds of metres wide,
  // which is what a real treeline looks like.
  //
  // Applied after the sea test on purpose: perturbing that would push water
  // inland and dry land out to sea.
  float e = elevation + tnrf_fbm(worldXZ * 0.0022, 2, 2.1, 0.5) * 85.0;

  // WorldCover says "tree cover" but not *which* trees, and the difference
  // between laurisilva and Canary pine is most of the island's character. So
  // elevation and aspect disambiguate what cover alone cannot: the wet
  // north-facing 400-1200 m belt is cloud forest, above that is pine.
  if (cover == TNRF_COVER_TREES) {
    if (e > 1100.0) return TNRF_BIOME_PINE;
    return wetness > 0.5 ? TNRF_BIOME_LAURISILVA : TNRF_BIOME_PINE;
  }

  // Shrub and grass split by altitude: retama above the treeline, euphorbia
  // scrub on the arid coast.
  if (cover == TNRF_COVER_SHRUB || cover == TNRF_COVER_GRASS) {
    if (e > 2650.0) return TNRF_BIOME_LAVA;
    if (e > 1900.0) return TNRF_BIOME_RETAMA;
    if (e > 400.0 && wetness > 0.55) return TNRF_BIOME_LAURISILVA;
    return TNRF_BIOME_COASTAL_ARID;
  }

  // Anything left (wetland, moss, unmapped) falls back to the elevation bands.
  if (e > 2750.0) return TNRF_BIOME_LAVA;
  if (e > 2000.0) return TNRF_BIOME_RETAMA;
  if (e > 1100.0) return TNRF_BIOME_PINE;
  if (e > 400.0) return wetness > 0.55 ? TNRF_BIOME_LAURISILVA : TNRF_BIOME_PINE;
  return TNRF_BIOME_COASTAL_ARID;
}

/** How wet a slope is: 1 facing north, 0 facing south. */
float tnrf_wetness(vec3 normal) {
  // -Z is north in the island-local frame.
  return clamp(-normal.z * 1.4 + 0.5, 0.0, 1.0);
}

/**
 * Vertical displacement added on top of the heightfield, in metres.
 *
 * Amplitude and character are conditioned on biome, because the surfaces differ
 * enormously at this scale: fresh lava in Las Cañadas is violently rough, a
 * banana terrace is nearly flat, and forest floor is somewhere between. Using
 * one amplitude everywhere is the single most obvious tell that terrain is
 * procedural.
 */
float tnrf_detail(vec2 worldXZ, int biome, float slope) {
  // Metres per noise cell for the base octave.
  float amplitude;
  float frequency;
  float ridginess;

  if (biome == TNRF_BIOME_LAVA) {
    // Sharp, chaotic, high-relief: ridged noise dominates.
    amplitude = 3.4;
    frequency = 1.0 / 26.0;
    ridginess = 0.8;
  } else if (biome == TNRF_BIOME_RETAMA) {
    amplitude = 1.8;
    frequency = 1.0 / 34.0;
    ridginess = 0.45;
  } else if (biome == TNRF_BIOME_PINE) {
    amplitude = 1.5;
    frequency = 1.0 / 40.0;
    ridginess = 0.25;
  } else if (biome == TNRF_BIOME_LAURISILVA) {
    // Deeply weathered, soil-covered, rounded.
    amplitude = 1.1;
    frequency = 1.0 / 46.0;
    ridginess = 0.1;
  } else if (biome == TNRF_BIOME_CULTIVATED) {
    // Terracing flattens the ground; keep this very low or the fields look
    // ploughed into dunes.
    amplitude = 0.45;
    frequency = 1.0 / 60.0;
    ridginess = 0.0;
  } else if (biome == TNRF_BIOME_URBAN) {
    // Towns are graded flat. Any roughness here reads as subsidence.
    amplitude = 0.15;
    frequency = 1.0 / 70.0;
    ridginess = 0.0;
  } else if (biome == TNRF_BIOME_SEA) {
    return 0.0;
  } else {
    amplitude = 1.3;
    frequency = 1.0 / 38.0;
    ridginess = 0.35;
  }

  vec2 p = worldXZ * frequency;
  float rolling = tnrf_fbm(p, 5, 2.02, 0.5);
  float crests = tnrf_ridged(p, 5, 2.02, 0.5) * 2.0 - 1.0;
  float n = mix(rolling, crests, ridginess);

  // Steep ground gets more relief: this is where rockfall, gullies and outcrops
  // live, and it stops cliffs reading as smooth ramps.
  amplitude *= 1.0 + slope * 1.6;

  return n * amplitude;
}
