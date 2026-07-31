/**
 * CPU half of the biome and surface-detail contract.
 *
 * MUST MATCH `src/shaders/surface.glsl`. Change one, change both;
 * `test/noise-parity.test.ts` asserts they agree.
 *
 * The drone collides against what this file computes while the player looks at
 * what the shader computes, so a divergence here is felt as the drone clipping
 * into solid-looking rock.
 */

import { COVER } from '../geo/landcover.ts'
import { fbm, ridged } from './noise.ts'

const f32 = Math.fround

/** Biome ids. Must match the constants in surface.glsl. */
export const BIOME = {
  SEA: 0,
  COASTAL_ARID: 1,
  CULTIVATED: 2,
  LAURISILVA: 3,
  PINE: 4,
  RETAMA: 5,
  LAVA: 6,
  URBAN: 7,
} as const

export type BiomeId = (typeof BIOME)[keyof typeof BIOME]

export const BIOME_NAMES: Record<number, string> = {
  [BIOME.SEA]: 'sea',
  [BIOME.COASTAL_ARID]: 'coastal scrub',
  [BIOME.CULTIVATED]: 'cultivated',
  [BIOME.LAURISILVA]: 'laurisilva',
  [BIOME.PINE]: 'Canary pine',
  [BIOME.RETAMA]: 'retama',
  [BIOME.LAVA]: 'lava / bare rock',
  [BIOME.URBAN]: 'built-up',
}

/** How wet a slope is: 1 facing north, 0 facing south. Matches `tnrf_wetness`. */
export function wetness(normalZ: number): number {
  return Math.min(1, Math.max(0, -normalZ * 1.4 + 0.5))
}

/**
 * Tenerife's altitudinal vegetation banding. Matches `tnrf_biome`.
 *
 * See the GLSL for why aspect is an input: the trade winds make the north side
 * cloud forest and the south side arid at identical altitudes.
 */
export function classifyBiome(
  worldX: number,
  worldZ: number,
  elevation: number,
  slope: number,
  wet: number,
  cover: number,
): BiomeId {
  if (elevation < 1 || cover === COVER.WATER) return BIOME.SEA

  // Observed cover wins where unambiguous — elevation rules cannot know where a
  // town is. See the GLSL for the full reasoning.
  if (cover === COVER.BUILT) return BIOME.URBAN
  if (cover === COVER.CROPLAND) return BIOME.CULTIVATED

  if (slope > 0.72) return BIOME.LAVA
  if (cover === COVER.BARE || cover === COVER.SNOW) return BIOME.LAVA

  const e = f32(
    elevation + f32(fbm(f32(worldX * 0.0022), f32(worldZ * 0.0022), 2, 2.1, 0.5) * 85),
  )

  if (cover === COVER.TREES) {
    if (e > 1100) return BIOME.PINE
    return wet > 0.5 ? BIOME.LAURISILVA : BIOME.PINE
  }

  if (cover === COVER.SHRUB || cover === COVER.GRASS) {
    if (e > 2650) return BIOME.LAVA
    if (e > 1900) return BIOME.RETAMA
    if (e > 400 && wet > 0.55) return BIOME.LAURISILVA
    return BIOME.COASTAL_ARID
  }

  if (e > 2750) return BIOME.LAVA
  if (e > 2000) return BIOME.RETAMA
  if (e > 1100) return BIOME.PINE
  if (e > 400) return wet > 0.55 ? BIOME.LAURISILVA : BIOME.PINE
  return BIOME.COASTAL_ARID
}

interface DetailParams {
  amplitude: number
  frequency: number
  ridginess: number
}

/** Per-biome surface character. Must match the branches in `tnrf_detail`. */
function detailParams(biome: number): DetailParams | null {
  switch (biome) {
    case BIOME.LAVA:
      return { amplitude: 3.4, frequency: 1 / 26, ridginess: 0.8 }
    case BIOME.RETAMA:
      return { amplitude: 1.8, frequency: 1 / 34, ridginess: 0.45 }
    case BIOME.PINE:
      return { amplitude: 1.5, frequency: 1 / 40, ridginess: 0.25 }
    case BIOME.LAURISILVA:
      return { amplitude: 1.1, frequency: 1 / 46, ridginess: 0.1 }
    case BIOME.CULTIVATED:
      return { amplitude: 0.45, frequency: 1 / 60, ridginess: 0 }
    case BIOME.URBAN:
      return { amplitude: 0.15, frequency: 1 / 70, ridginess: 0 }
    case BIOME.SEA:
      return null
    default:
      return { amplitude: 1.3, frequency: 1 / 38, ridginess: 0.35 }
  }
}

/** Vertical displacement in metres added on top of the heightfield. Matches `tnrf_detail`. */
export function surfaceDetail(
  worldX: number,
  worldZ: number,
  biome: number,
  slope: number,
): number {
  const params = detailParams(biome)
  if (!params) return 0

  const px = f32(worldX * params.frequency)
  const pz = f32(worldZ * params.frequency)

  const rolling = fbm(px, pz, 5, 2.02, 0.5)
  const crests = f32(f32(ridged(px, pz, 5, 2.02, 0.5) * 2) - 1)
  const n = f32(rolling + f32(crests - rolling) * params.ridginess)

  const amplitude = f32(params.amplitude * f32(1 + f32(slope * 1.6)))
  return f32(n * amplitude)
}
