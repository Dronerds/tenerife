/**
 * Procedurally generated foliage silhouettes.
 *
 * Each plant is drawn as crossed vertical billboards *plus a horizontal canopy
 * quad*, so this generates a two-tile atlas per growth habit: a side view for the
 * vertical quads and a top view for the horizontal one.
 *
 * The top view is not optional decoration. Crossed vertical billboards seen from
 * directly above are edge-on, so from a drone at 50 m a forest of them reads as a
 * field of thin lines rather than a canopy. The horizontal quad is what makes
 * vegetation work at survey altitude, and it needs its own silhouette because a
 * tree from above looks nothing like a tree from the side.
 *
 * Silhouettes are species-specific because the *outline* is what identifies a
 * plant at distance. A generic blob is what made the first version read as
 * cardboard — Canary pine is open and tiered, tabaiba is a candelabra, banana is
 * a rosette of huge drooping paddles, and none of those is a rounded lump.
 *
 * Alpha *test* rather than alpha blend: thousands of overlapping billboards would
 * need per-instance depth sorting to blend correctly. Testing needs none.
 */

import { DataTexture, LinearFilter, RGBAFormat, type Texture } from 'three'

import { hash, hashToUnit } from '../procedural/noise.ts'

/** Resolution of one atlas tile. */
const TILE = 160
/** Atlas is two tiles side by side: [0, 0.5) side view, [0.5, 1] top view. */
const ATLAS_W = TILE * 2
const ATLAS_H = TILE

export type Habit = 'conifer' | 'broadleaf' | 'candelabra' | 'broom' | 'banana' | 'palm'

/** Smooth value noise for ragging outlines. Texture generation only. */
function wobble(x: number, y: number, freq: number, seed: number): number {
  const fx = x * freq
  const fy = y * freq
  const ix = Math.floor(fx)
  const iy = Math.floor(fy)
  const tx = fx - ix
  const ty = fy - iy
  const s = (a: number) => a * a * (3 - 2 * a)
  const a = hashToUnit(hash(ix + seed, iy))
  const b = hashToUnit(hash(ix + 1 + seed, iy))
  const c = hashToUnit(hash(ix + seed, iy + 1))
  const d = hashToUnit(hash(ix + 1 + seed, iy + 1))
  const top = a + (b - a) * s(tx)
  const bottom = c + (d - c) * s(tx)
  return top + (bottom - top) * s(ty)
}

/**
 * Coverage of a leaf-clump field — gives foliage texture rather than flat fill.
 *
 * Keep the frequency low and the threshold low. High-frequency clumping against a
 * hard alpha test produces per-pixel speckle that reads as dirt or noise, not as
 * leaves, and it aliases badly as the camera moves.
 */
function clumps(u: number, v: number, freq: number, threshold: number, seed: number): boolean {
  const n = wobble(u, v, freq, seed) * 0.65 + wobble(u, v, freq * 2.3, seed + 31) * 0.35
  return n > threshold
}

/** Side-view coverage. `v` runs 0 at the base to 1 at the tip. */
function sideCoverage(habit: Habit, u: number, v: number): boolean {
  const dx = Math.abs(u - 0.5) * 2

  if (habit === 'conifer') {
    // Canary pine: tall, bare-trunked, and conspicuously *open* — several
    // distinct tiers of drooping branches with sky between them. A solid cone
    // reads as spruce and puts an alpine forest on a subtropical island.
    if (v < 0.34) return false
    const t = (v - 0.34) / 0.66
    // Tiering: branch clusters at intervals up the trunk.
    const tier = Math.sin(t * Math.PI * 3.4)
    const profile = (1 - t * 0.82) * (0.55 + 0.45 * Math.max(tier, 0))
    const edge = profile * (0.8 + 0.4 * wobble(u, v, 11, 11))
    if (dx > edge) return false
    // Droop: needles hang, so bias coverage downwards within each tier.
    const droop = wobble(u, v * 3.0, 14, 5)
    return droop > 0.18 && clumps(u, v, 12, 0.18, 3)
  }

  if (habit === 'broadleaf') {
    // Laurisilva: dense, closed, rounded, on a short trunk.
    if (v < 0.2) return false
    const ny = (v - 0.63) / 0.42
    const nx = (u - 0.5) / 0.5
    const r = Math.sqrt(nx * nx + ny * ny)
    const edge = 0.88 + 0.3 * wobble(u, v, 6, 23)
    if (r > edge) return false
    return clumps(u, v, 9, 0.04, 7)
  }

  if (habit === 'candelabra') {
    // Tabaiba / cardón: a cluster of thick vertical fingers rising from a common
    // base, each one blunt-tipped. Utterly distinctive, and nothing like a bush.
    if (v > 0.94) return false
    const fingers = 5
    // Which finger this column belongs to, and how far across it we are.
    const fx = u * fingers
    const index = Math.floor(fx)
    const within = Math.abs((fx - index) - 0.5) * 2
    // Fingers are shorter towards the outside of the clump.
    const centreBias = 1 - Math.abs(u - 0.5) * 1.5
    const top = 0.42 + 0.52 * centreBias * (0.7 + 0.3 * hashToUnit(hash(index, 91)))
    if (v > top) return false
    // Splay: the base is narrower than the crown.
    const width = 0.52 + 0.34 * Math.min(v / 0.35, 1)
    if (within > width) return false
    return v > 0.05 || within < 0.4
  }

  if (habit === 'broom') {
    // Retama: a low mound of fine upward twigs, airy enough to see through.
    if (v > 0.9) return false
    const ny = Math.max(0, (v - 0.15) / 0.72)
    const nx = (u - 0.5) / 0.5
    const r = Math.sqrt(nx * nx + ny * ny * 0.75)
    if (r > 0.9 + 0.24 * wobble(u, v, 9, 41)) return false
    // Radial twigs rather than a solid blob.
    const twig = Math.abs(Math.sin((u - 0.5) * 26 + v * 3.5))
    return twig > 0.42 && wobble(u, v, 30, 13) > 0.24
  }

  // Banana: a rosette of very large paddle leaves arching outwards and down from
  // a short thick pseudostem. Wide relative to its height, and the arching
  // outline is the whole recognisable signature of a plantation.
  // A short, thick pseudostem — banana has no woody trunk, and a tall thin one
  // is exactly what made this read as a poor palm.
  const stem = Math.abs(u - 0.5) < 0.1 && v < 0.32
  if (stem) return true
  const leaves = 6
  for (let i = 0; i < leaves; i++) {
    const seed = hash(i, 77)
    // Alternating sides, springing from around mid-height.
    const side = i % 2 === 0 ? 1 : -1
    // Blades spring from low on the plant and stand up steeply before flopping
    // over — the opposite of a palm's high crown of radiating fronds.
    const originV = 0.2 + 0.12 * hashToUnit(seed)
    const reach = 0.34 + 0.16 * hashToUnit(hash(seed, 2))
    const rise = 0.5 + 0.28 * hashToUnit(hash(seed, 3))
    // Parametric arch: out from the stem, up, then drooping down at the tip.
    const dxs = (u - 0.5) * side
    if (dxs < 0 || dxs > reach) continue
    const t = dxs / reach
    const arch = originV + rise * Math.sin(t * Math.PI * 0.62) - 0.3 * t * t * t
    // Banana leaves are enormous and barely taper — nothing like a pinnate frond.
    const bladeHalf = (0.155 - 0.05 * t) * (0.85 + 0.3 * hashToUnit(hash(seed, 4)))
    if (Math.abs(v - arch) < bladeHalf) return true
  }
  return false
}

/** Top-view coverage, for the horizontal canopy quad. */
function topCoverage(habit: Habit, u: number, v: number): boolean {
  const nx = (u - 0.5) * 2
  const nz = (v - 0.5) * 2
  const r = Math.sqrt(nx * nx + nz * nz)
  const angle = Math.atan2(nz, nx)

  if (habit === 'conifer') {
    // From above a Canary pine is a sparse star of radiating branch clusters
    // around a visible centre, not a disc — you can see the ground through it.
    const arms = 7
    const lobe = 0.62 + 0.3 * Math.abs(Math.sin(angle * arms * 0.5))
    if (r > lobe * (0.85 + 0.25 * wobble(u, v, 8, 61))) return false
    return r < 0.2 || clumps(u, v, 9, 0.2, 17)
  }

  if (habit === 'broadleaf') {
    // Closed canopy: a lumpy near-disc.
    if (r > 0.92 + 0.22 * wobble(u, v, 7, 71)) return false
    return clumps(u, v, 8, 0.02, 19)
  }

  if (habit === 'candelabra') {
    // The tops of the individual fingers, as separate blunt circles.
    const fingers = 6
    for (let i = 0; i < fingers; i++) {
      const a = (i / fingers) * Math.PI * 2 + hashToUnit(hash(i, 55)) * 0.6
      const rad = 0.34 + 0.26 * hashToUnit(hash(i, 56))
      const fx = Math.cos(a) * rad
      const fz = Math.sin(a) * rad
      if (Math.hypot(nx - fx, nz - fz) < 0.2) return true
    }
    return Math.hypot(nx, nz) < 0.17
  }

  if (habit === 'broom') {
    if (r > 0.88 + 0.24 * wobble(u, v, 10, 81)) return false
    const twig = Math.abs(Math.sin(angle * 13 + r * 5))
    return twig > 0.38
  }

  // Banana from above is the most recognisable of all: a rosette of long broad
  // blades radiating from the centre with clear gaps between them.
  const blades = 8
  for (let i = 0; i < blades; i++) {
    const seed = hash(i, 123)
    const a = (i / blades) * Math.PI * 2 + hashToUnit(seed) * 0.5
    let d = angle - a
    d = Math.atan2(Math.sin(d), Math.cos(d))
    const reach = 0.82 + 0.18 * hashToUnit(hash(seed, 5))
    // Angular half-width narrows with distance from the centre: a blade, not a
    // wedge.
    const halfAngle = 0.20 * (1 - r * 0.55)
    if (Math.abs(d) < halfAngle && r < reach) return true
  }
  return r < 0.13
}

/**
 * Build the atlas for one habit.
 *
 * RGB holds a shading variation used to break up flat colour within a crown; A
 * is the silhouette mask.
 */
export function createFoliageTexture(habit: Habit): Texture {
  const data = new Uint8Array(ATLAS_W * ATLAS_H * 4)

  for (let y = 0; y < ATLAS_H; y++) {
    for (let x = 0; x < ATLAS_W; x++) {
      const isTop = x >= TILE
      const tx = isTop ? x - TILE : x
      const u = (tx + 0.5) / TILE
      // Texture row 0 is the top of the tile, so the side view's v is flipped.
      const v = isTop ? (y + 0.5) / TILE : 1 - (y + 0.5) / TILE

      const covered = isTop ? topCoverage(habit, u, v) : sideCoverage(habit, u, v)

      // Shading: darker towards the interior and underside, so crowns read as
      // volumes rather than as flat cut-outs.
      // Kept in a narrow band near 1: this is meant to break up flat colour, not
      // to darken the crown. A wide range here compounds with the linear-space
      // albedo and the lighting term, and the result is a black blob.
      let shade = 0.86 + 0.14 * wobble(u, v, 20, 5)
      // No height-based darkening on the side view. It stacks with the linear
      // albedo and with overlapping crowns, and dense stands ended up black at
      // their base — laurisilva is dark in reality but not that dark.
      if (!isTop) shade *= 0.96 + 0.04 * v
      else shade *= 0.9 + 0.1 * Math.min(1, Math.hypot(u - 0.5, v - 0.5) * 2.4)

      const i = (y * ATLAS_W + x) * 4
      const c = Math.round(Math.min(1, shade) * 255)
      data[i] = c
      data[i + 1] = c
      data[i + 2] = c
      data[i + 3] = covered ? 255 : 0
    }
  }

  const texture = new DataTexture(data, ATLAS_W, ATLAS_H, RGBAFormat)
  texture.magFilter = LinearFilter
  texture.minFilter = LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

/** Habits that use the billboard atlas. `palm` has its own geometry and texture. */
export const HABITS: Habit[] = ['conifer', 'broadleaf', 'candelabra', 'broom', 'banana']
