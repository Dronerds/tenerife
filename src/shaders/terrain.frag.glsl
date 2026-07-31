/**
 * Terrain shading: biome ground materials, with debug modes retained.
 *
 * Colours are chosen from Tenerife's actual ground rather than a generic
 * elevation ramp — the black-brown basaltic picón of Las Cañadas, the ochre
 * weathered tuff of the mid slopes, the dark wet green of the laurisilva, the
 * pale dusty terraces of the coastal strip.
 *
 * Requires noise.glsl and surface.glsl to be prepended (see terrain.ts).
 */

precision highp float;
precision highp sampler2D;

// Matching half of the logarithmic-depth opt-in; see terrain.vert.glsl.
#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
// getShadowMask() lives in its own chunk, not in shadowmap_pars_fragment.
#include <shadowmask_pars_fragment>
#include <logdepthbuf_pars_fragment>
// No `tonemapping_pars_fragment` / `colorspace_pars_fragment` here: three.js
// already injects both into every non-raw fragment shader, and including them
// again redefines every function and fails to link.

uniform sampler2D uHeightmap;
uniform sampler2D uLandCover;
/** Sentinel-2 median composite, aligned to the grid. Mid/far field only. */
uniform sampler2D uImagery;
/** 0 disables imagery entirely (and is the value when none was generated). */
uniform float uImageryBlend;
uniform vec2 uGridMin;
uniform float uGridResolution;
uniform vec2 uGridSizeTexels;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
/** Must match the sea plane's colour, or the grid edge shows as a hard seam. */
uniform vec3 uSeaColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
/** Baked tiling detail normal (rgb) + height (a). See detail-texture.ts. */
uniform sampler2D uDetailMap;
/** World-space size of one uDetailMap tile, metres. */
uniform float uDetailTile;
uniform float uDetailScale;
/** 0 = materials, 1 = quadtree depth, 2 = morph factor, 3 = biome. */
uniform int uDebugMode;

varying vec3 vWorldPos;
varying float vDepth;
varying float vMorphK;
varying float vSlope;
varying float vDetail;

float sampleHeight(vec2 worldXZ) {
  vec2 texel = (worldXZ - uGridMin) / uGridResolution;
  vec2 uv = (texel + 0.5) / uGridSizeTexels;
  return texture2D(uHeightmap, uv).r;
}

/**
 * Normal from central differences on the heightmap rather than from
 * interpolated vertex normals, so shading stays consistent across LOD levels
 * instead of flattening out as nodes coarsen.
 */
vec3 baseNormal(vec2 worldXZ) {
  float e = uGridResolution;
  float hL = sampleHeight(worldXZ - vec2(e, 0.0));
  float hR = sampleHeight(worldXZ + vec2(e, 0.0));
  float hD = sampleHeight(worldXZ - vec2(0.0, e));
  float hU = sampleHeight(worldXZ + vec2(0.0, e));
  return normalize(vec3(hL - hR, 2.0 * e, hD - hU));
}

/** Texture coordinate for any of the grid-aligned rasters. */
vec2 coverUv(vec2 worldXZ) {
  vec2 texel = (worldXZ - uGridMin) / uGridResolution;
  return (texel + 0.5) / uGridSizeTexels;
}

/** Observed land-cover class. Nearest-filtered; see terrain.vert.glsl. */
int sampleCover(vec2 worldXZ) {
  return int(texture2D(uLandCover, coverUv(worldXZ)).r * 255.0 + 0.5);
}

/** Per-biome strength of the fine normal perturbation. */
float biomeDetailStrength(int biome) {
  if (biome == TNRF_BIOME_LAVA) return 1.55;
  if (biome == TNRF_BIOME_RETAMA) return 0.95;
  if (biome == TNRF_BIOME_PINE) return 0.75;
  if (biome == TNRF_BIOME_LAURISILVA) return 0.55;
  if (biome == TNRF_BIOME_CULTIVATED) return 0.28;
  if (biome == TNRF_BIOME_URBAN) return 0.12;
  if (biome == TNRF_BIOME_SEA) return 0.0;
  return 0.7;
}

/**
 * Fine normal perturbation, from the baked tiling detail map.
 *
 * This carries surface texture out past the range where the displaced geometry
 * itself is visible; without it, ground more than a couple of hundred metres
 * away goes billiard-smooth and the illusion collapses.
 *
 * Sampled at two scales an octave and a bit apart, which breaks up the tile
 * repetition well enough that the 64 m period is not readable on open ground.
 * Faded out with distance because past a few hundred metres it is subpixel and
 * only produces aliasing — normals may be faded by distance, unlike geometry,
 * because nothing collides with a normal.
 */
vec3 detailNormal(vec2 worldXZ, int biome, vec3 base, float dist) {
  float strength = biomeDetailStrength(biome) * uDetailScale;
  float fade = 1.0 - smoothstep(250.0, 900.0, dist);
  strength *= fade;
  if (strength <= 0.001) return base;

  vec3 a = texture2D(uDetailMap, worldXZ / uDetailTile).xyz * 2.0 - 1.0;
  vec3 b = texture2D(uDetailMap, worldXZ / (uDetailTile * 0.19)).xyz * 2.0 - 1.0;
  vec3 bump = a + b * 0.55;

  // The baked map is tangent-space with +Z up; the terrain's up is +Y.
  return normalize(base + vec3(bump.x, 0.0, bump.y) * strength);
}

/**
 * Convert a hand-authored sRGB colour into the linear working space.
 *
 * The albedo constants below were picked by eye as "what this should look like
 * on screen", i.e. in sRGB. Lighting and fog operate in linear space, and the
 * output conversion then re-encodes to sRGB — so feeding sRGB values straight
 * into the lighting brightens everything by roughly a factor of two. That is
 * what made the retama band read as snow rather than pumice.
 */
vec3 tnrf_srgbToLinear(vec3 c) {
  return pow(c, vec3(2.2));
}

/**
 * Ground albedo per biome, in sRGB — convert with tnrf_srgbToLinear before use.
 * Varied by a low-frequency noise so no biome is a flat wash of one colour.
 */
vec3 biomeAlbedo(int biome, vec2 worldXZ, float elevation) {
  // Reuse the detail map's height channel at a large scale rather than running
  // another fBm per pixel — same visual result, a fraction of the cost.
  float mottle = texture2D(uDetailMap, worldXZ / (uDetailTile * 13.0)).a * 2.0 - 1.0;

  if (biome == TNRF_BIOME_LAVA) {
    // Basaltic picón: near-black, reddening where older and oxidised. Above the
    // treeline Tenerife's ground is genuinely this dark.
    vec3 fresh = vec3(0.085, 0.075, 0.075);
    vec3 oxidised = vec3(0.26, 0.15, 0.11);
    return mix(fresh, oxidised, smoothstep(-0.3, 0.5, mottle));
  }
  if (biome == TNRF_BIOME_RETAMA) {
    // Pale pumice with sparse silver-green broom over it.
    vec3 pumice = vec3(0.42, 0.36, 0.30);
    vec3 broom = vec3(0.34, 0.36, 0.25);
    return mix(pumice, broom, smoothstep(-0.2, 0.6, mottle) * 0.65);
  }
  if (biome == TNRF_BIOME_PINE) {
    // Canary pine is sparse — a lot of rusty needle litter shows through.
    vec3 litter = vec3(0.32, 0.24, 0.15);
    vec3 canopy = vec3(0.16, 0.22, 0.12);
    return mix(litter, canopy, smoothstep(-0.4, 0.5, mottle) * 0.8);
  }
  if (biome == TNRF_BIOME_LAURISILVA) {
    // Dense, wet, dark. The defining colour of the north-facing slopes.
    vec3 deep = vec3(0.07, 0.13, 0.08);
    vec3 lit = vec3(0.14, 0.24, 0.12);
    return mix(deep, lit, smoothstep(-0.5, 0.5, mottle));
  }
  if (biome == TNRF_BIOME_CULTIVATED) {
    // Terraced plots: banana green against bare volcanic soil.
    vec3 soil = vec3(0.34, 0.26, 0.19);
    vec3 crop = vec3(0.22, 0.34, 0.14);
    return mix(soil, crop, smoothstep(-0.1, 0.35, mottle));
  }
  if (biome == TNRF_BIOME_URBAN) {
    // Canarian towns from the air: pale render and flat roofs, with terracotta
    // in the older quarters, cut by grey asphalt.
    vec3 render = vec3(0.62, 0.59, 0.55);
    vec3 terracotta = vec3(0.51, 0.31, 0.23);
    vec3 c = mix(render, terracotta, smoothstep(0.05, 0.45, mottle) * 0.75);
    return mix(c, vec3(0.30, 0.29, 0.29), smoothstep(-0.45, -0.15, mottle) * 0.6);
  }
  // Coastal arid: euphorbia scrub on dusty ground, bleaching towards the shore.
  vec3 dust = vec3(0.46, 0.39, 0.29);
  vec3 scrub = vec3(0.29, 0.31, 0.20);
  vec3 c = mix(dust, scrub, smoothstep(-0.2, 0.5, mottle) * 0.7);
  return mix(vec3(0.52, 0.47, 0.39), c, smoothstep(0.0, 60.0, elevation));
}

/** Distinct hues per quadtree depth so LOD banding is obvious. */
vec3 depthColor(float d) {
  float t = d / 10.0;
  return 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67)));
}

/** Flat colour per biome id, for the biome debug view. */
vec3 biomeDebugColor(int b) {
  if (b == TNRF_BIOME_SEA) return vec3(0.1, 0.2, 0.4);
  if (b == TNRF_BIOME_COASTAL_ARID) return vec3(0.9, 0.8, 0.4);
  if (b == TNRF_BIOME_CULTIVATED) return vec3(0.6, 0.85, 0.3);
  if (b == TNRF_BIOME_LAURISILVA) return vec3(0.0, 0.45, 0.2);
  if (b == TNRF_BIOME_PINE) return vec3(0.2, 0.55, 0.55);
  if (b == TNRF_BIOME_RETAMA) return vec3(0.85, 0.6, 0.75);
  if (b == TNRF_BIOME_URBAN) return vec3(1.0, 0.25, 0.2);
  return vec3(0.35, 0.3, 0.3);
}

void main() {
  #include <logdepthbuf_fragment>

  vec3 base = baseNormal(vWorldPos.xz);

  // Biome is classified here rather than passed down from the vertex stage.
  //
  // Interpolating a biome *id* across a triangle is meaningless: between id 4
  // (pine) and id 6 (lava) the interpolated value passes through 5 (retama),
  // painting a spurious band of the wrong material along every boundary between
  // non-adjacent biomes. Reclassifying per fragment costs almost nothing here
  // because `base` is already computed for shading.
  int biome = tnrf_biome(
    vWorldPos.xz, vWorldPos.y, vSlope, tnrf_wetness(base), sampleCover(vWorldPos.xz)
  );

  // The grid covers open ocean out to its rectangular edge, where the source
  // DEM is flat zero. Shade that as water so it joins the sea plane invisibly.
  float submerged = 1.0 - smoothstep(0.0, 2.0, vWorldPos.y);

  float viewDist = length(vWorldPos - cameraPosition);
  vec3 normal = biome == TNRF_BIOME_SEA
    ? vec3(0.0, 1.0, 0.0)
    : detailNormal(vWorldPos.xz, biome, base, viewDist);
  normal = mix(normal, vec3(0.0, 1.0, 0.0), submerged);

  /**
   * Satellite colour, blended in with distance.
   *
   * Near the camera the procedural materials win, because at 30 m posting the
   * imagery has no detail at all — it would look like a blurry photograph
   * stretched over the ground. Far away the imagery wins, because that is where
   * real colour variation reads and procedural biomes start to look like
   * repeating wallpaper across a whole hillside.
   *
   * Blending by *distance* is safe here in a way it would not be for geometry:
   * shading may change with viewpoint without anything popping or swimming.
   */
  vec3 satellite = tnrf_srgbToLinear(texture2D(uImagery, coverUv(vWorldPos.xz)).rgb);
  float satWeight = smoothstep(400.0, 2600.0, viewDist) * uImageryBlend;
  // Guard against no-data: black imagery would otherwise blacken distant ground.
  satWeight *= step(0.006, dot(satellite, vec3(0.333)));

  vec3 albedo;
  if (uDebugMode == 1) {
    albedo = depthColor(vDepth);
  } else if (uDebugMode == 2) {
    albedo = mix(vec3(0.1, 0.2, 0.8), vec3(1.0, 0.85, 0.1), vMorphK);
  } else if (uDebugMode == 3) {
    albedo = biomeDebugColor(biome);
  } else {
    // uSeaColor arrives already linear (three converts Color constants into the
    // working space), so it is mixed in after the conversion, not before.
    albedo = tnrf_srgbToLinear(biomeAlbedo(biome, vWorldPos.xz, vWorldPos.y));
    albedo = mix(albedo, satellite, satWeight);
    albedo = mix(albedo, uSeaColor, submerged);
  }

  float lambert = max(dot(normal, normalize(uSunDirection)), 0.0);
  // Hemispheric sky fill, so shadowed north faces read as blue-lit rather than
  // black — which is how they actually look under the trade-wind sky.
  float skyAmount = 0.5 + 0.5 * normal.y;

  // Shadowing. Without this nothing occludes anything: buildings do not darken
  // the street beside them and a forest is uniformly lit through its own canopy,
  // which is the single strongest cue that a scene is synthetic.
  float shadow = getShadowMask();
  vec3 color = albedo * (uSunColor * lambert * shadow + uSkyColor * skyAmount);
  // Keep the sea flat-lit so it matches the unlit sea plane exactly.
  if (uDebugMode == 0) color = mix(color, uSeaColor, submerged);

  // Aerial perspective, so the far side of the island recedes instead of
  // sitting flat against the sky. This replicates three's FogExp2 exactly,
  // because the sea plane is fogged by the scene and the two have to agree.
  float haze = 1.0 - exp(-uFogDensity * uFogDensity * viewDist * viewDist);
  color = mix(color, uFogColor, haze);

  gl_FragColor = vec4(color, 1.0);

  // Shading above happens in the linear working space, and uniform colours
  // arrive linear too. Built-in materials get tone mapping and the output
  // conversion appended for them; without them the terrain is output raw while
  // the sea plane is converted, so the two disagree and the edge of the height
  // grid reappears as a seam on the horizon. Order matters: tone map first.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
