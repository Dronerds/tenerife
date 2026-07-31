/**
 * Tenerife's vegetation, by altitudinal band.
 *
 * The island is a textbook case of altitudinal zonation, which is a gift: the
 * bands are sharp, well documented, and derivable from elevation and aspect
 * alone. Getting the *silhouettes* and densities right per band does more for
 * believability at 20 m AGL than any amount of texture resolution.
 *
 * Each species is a crude billboard-and-trunk proxy, not a modelled plant. At
 * the altitude the drone flies, shape and density read; leaf detail does not.
 */

import { Color } from 'three'

import type { Habit } from './foliage-texture.ts'

export interface Species {
  name: string
  /** Instances per square kilometre at full density. */
  densityPerKm2: number
  /** Mean height in metres, and the fraction it varies by. */
  height: number
  heightVariance: number
  /** Crown width as a multiple of height. */
  crownRatio: number
  /**
   * Canopy colour, sRGB.
   *
   * Pick these brighter than instinct suggests. three converts them to the linear
   * working space, the foliage texture then multiplies by a 0.8-1.0 shading term,
   * and the result is multiplied again by lighting — so a colour that looks like
   * "dark forest green" on a palette lands very close to black on screen.
   */
  crown: Color
  /** Trunk colour, sRGB. Ignored when `trunk` is false. */
  bark: Color
  /** Whether to draw a trunk at all — shrubs do not get one. */
  trunk: boolean
  /** Steepest slope (1 - normal.y) this species will grow on. */
  maxSlope: number
  /** Growth habit, selecting which foliage silhouette to use. */
  habit: Habit
  /**
   * How the plant is built.
   *
   * `billboard` is crossed quads plus a canopy quad. It is kept only for the low
   * shrubs, where the plant is small enough that its outline really is all there
   * is to see.
   *
   * Everything of tree size gets real geometry — `palm`, `pine`, `laurel`. Two
   * crossed quads have no volume, and from 50 m that is the only thing you see:
   * they read as flat rounded blobs however good the silhouette texture is. See
   * tree-geometry.ts and palm.ts.
   */
  build: 'billboard' | 'palm' | 'pine' | 'laurel'
  /**
   * How instances are distributed.
   *
   * `scattered` is random-but-deterministic within a cell. `rows` plants on a
   * rotated regular lattice in blocks — which is how cultivation actually looks,
   * and for banana on Tenerife the *pattern* of rows is more recognisable from
   * the air than any individual plant.
   */
  planting: 'scattered' | 'rows'
  /** Row and in-row spacing in metres. Only used when planting is `rows`. */
  rowSpacing?: number
}

/**
 * Canary pine — *Pinus canariensis*. Tall, notably sparse and open, with long
 * drooping needles, growing in the 1000-2000 m belt. The openness matters: a
 * dense conifer forest looks like the Alps, not Tenerife.
 */
const CANARY_PINE: Species = {
  name: 'Canary pine',
  build: 'pine',
  habit: 'conifer',
  planting: 'scattered',
  densityPerKm2: 3200,
  height: 22,
  heightVariance: 0.35,
  crownRatio: 0.55,
  crown: new Color(0x8ba85c),
  bark: new Color(0x9a7d5e),
  trunk: false,
  maxSlope: 0.62,
}

/**
 * Laurisilva — relict subtropical cloud forest on the wet north-facing slopes
 * between roughly 400 and 1200 m. Dense, closed canopy, distinctly darker than
 * anything else on the island.
 */
const LAUREL: Species = {
  name: 'laurel',
  build: 'laurel',
  habit: 'broadleaf',
  planting: 'scattered',
  densityPerKm2: 6500,
  height: 14,
  heightVariance: 0.3,
  crownRatio: 0.85,
  crown: new Color(0x6f9450),
  bark: new Color(0x7a6d5c),
  trunk: false,
  maxSlope: 0.7,
}

/**
 * Tabaiba / cardón — the euphorbia scrub of the arid coastal strip. A cluster of
 * blunt vertical fingers, grey-green, widely spaced over bare ground.
 */
const EUPHORBIA: Species = {
  name: 'tabaiba',
  build: 'billboard',
  habit: 'candelabra',
  planting: 'scattered',
  densityPerKm2: 9000,
  height: 1.6,
  heightVariance: 0.45,
  crownRatio: 1.1,
  crown: new Color(0x93a075),
  bark: new Color(0x93a075),
  trunk: false,
  maxSlope: 0.75,
}

/**
 * Retama del Teide — white broom, the dominant plant above the treeline in Las
 * Cañadas. Low rounded mounds, pale silver-green, sparse over pumice.
 */
const RETAMA: Species = {
  name: 'retama',
  build: 'billboard',
  habit: 'broom',
  planting: 'scattered',
  densityPerKm2: 4200,
  height: 1.9,
  heightVariance: 0.4,
  crownRatio: 1.5,
  crown: new Color(0xa9b189),
  bark: new Color(0xa9b189),
  trunk: false,
  maxSlope: 0.6,
}

/**
 * Banana — genuinely everywhere on Tenerife's north coastal strip, and the most
 * recognisable planting on the island: a rosette of huge drooping paddle leaves,
 * set out in dense regular rows.
 *
 * The rows matter more than the plant. From the air a plantation reads as a
 * striped rectangular block long before any individual leaf is resolvable, and
 * scattering these randomly (as the first version did) throws away the only cue
 * that actually identifies it.
 */
const BANANA: Species = {
  name: 'banana',
  build: 'billboard',
  habit: 'banana',
  // Planted in rows, so density comes from rowSpacing rather than this figure;
  // it is kept only as the budget hint for instance capacity.
  densityPerKm2: 180000,
  planting: 'rows',
  // Real plantations run roughly 2.2 m between plants and 2.6 m between rows.
  rowSpacing: 2.4,
  height: 3.4,
  heightVariance: 0.18,
  // Wider than tall: banana leaves reach further sideways than the plant rises.
  crownRatio: 1.35,
  crown: new Color(0x8dbf4e),
  bark: new Color(0x93a05c),
  trunk: false,
  maxSlope: 0.26,
}

/**
 * Canary Island date palm — *Phoenix canariensis*. The island's emblematic tree,
 * and unavoidable in reality: it lines the promenades of Puerto de la Cruz, fills
 * the barrancos, and stands over every plaza and hotel garden.
 *
 * Built as real geometry rather than a billboard; see palm.ts for why that is not
 * optional for this species.
 */
const PALM: Species = {
  name: 'Canary palm',
  build: 'palm',
  habit: 'palm',
  planting: 'scattered',
  // Palms are street trees and garden specimens, not a forest — but they are also
  // excluded from building footprints, so the effective density in a dense town is
  // far lower than this figure suggests.
  densityPerKm2: 1700,
  height: 13,
  heightVariance: 0.3,
  // Crown diameter is close to the trunk height for a mature palm.
  crownRatio: 1.0,
  crown: new Color(0x86a352),
  bark: new Color(0x8c7a5f),
  trunk: false,
  maxSlope: 0.55,
}

/** Species present in each biome, by biome id. Empty means bare ground. */
export const BIOME_SPECIES: Record<number, Species[]> = {
  0: [], // sea
  1: [EUPHORBIA, PALM], // coastal arid
  2: [BANANA, PALM], // cultivated
  3: [LAUREL], // laurisilva
  4: [CANARY_PINE], // pine
  5: [RETAMA], // retama
  6: [], // lava / bare rock — genuinely bare
  // Built-up: palms only. Canarian towns are full of them — along seafronts, in
  // plazas, in hotel gardens — and they are the one plant that improves a
  // townscape rather than cluttering it. No shrubs: scattering generic bushes
  // over streets and rooftops looks worse than bare ground.
  7: [PALM],
}

export const ALL_SPECIES: Species[] = [
  CANARY_PINE,
  LAUREL,
  EUPHORBIA,
  RETAMA,
  BANANA,
  PALM,
]
