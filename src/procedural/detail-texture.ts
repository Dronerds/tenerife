/**
 * A baked, tiling detail normal + height map.
 *
 * This exists for performance, and the reasoning is worth recording because it
 * shapes where noise may and may not be evaluated.
 *
 * Surface detail is needed in two places with very different budgets:
 *
 *   - **Vertex stage**, to displace geometry. This MUST agree bit-for-bit with
 *     the CPU (the drone collides against it), so it uses the analytic noise in
 *     `noise.ts` / `noise.glsl`. There are only ~1 M vertices, so ~10 noise
 *     evaluations each is affordable.
 *
 *   - **Fragment stage**, to perturb normals so the ground has texture beyond
 *     the range where displaced geometry is visible. Nothing collides with a
 *     normal, so nothing needs parity here — and evaluating the analytic noise
 *     per pixel cost ~160 integer hashes per fragment, which measured at 17 fps.
 *
 * So the fragment stage samples this instead: two texture fetches replacing a
 * billion integer operations per frame.
 *
 * The noise used here is *periodic* — hash coordinates wrap at the tile size —
 * so the texture tiles seamlessly. Ordinary non-periodic noise would show a
 * visible grid of discontinuities across the terrain.
 */

import { DataTexture, LinearFilter, RGBAFormat, RepeatWrapping, type Texture } from 'three'

import { hash, hashToUnit } from './noise.ts'

/** Texture resolution. 512 is plenty given it is sampled at several scales. */
const SIZE = 512

/**
 * World-space size of one tile, metres. Also the noise period, so the pattern
 * repeats exactly at the texture seam.
 */
export const DETAIL_TILE_METRES = 64

/** Quintic fade, matching the analytic noise. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/** Value noise whose lattice wraps at `period`, so results tile. */
function periodicNoise(x: number, y: number, period: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const wx = fade(fx)
  const wy = fade(fy)

  const wrap = (v: number): number => ((v % period) + period) % period
  const x0 = wrap(ix)
  const y0 = wrap(iy)
  const x1 = wrap(ix + 1)
  const y1 = wrap(iy + 1)

  const a = hashToUnit(hash(x0, y0))
  const b = hashToUnit(hash(x1, y0))
  const c = hashToUnit(hash(x0, y1))
  const d = hashToUnit(hash(x1, y1))

  const top = a + (b - a) * wx
  const bottom = c + (d - c) * wx
  return top + (bottom - top) * wy
}

/** Periodic fBm in [-1,1]. Period doubles with each octave to stay tileable. */
function periodicFbm(x: number, y: number, octaves: number, basePeriod: number): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let freq = 1
  for (let i = 0; i < octaves; i++) {
    sum += (periodicNoise(x * freq, y * freq, basePeriod * freq) * 2 - 1) * amp
    norm += amp
    freq *= 2
    amp *= 0.5
  }
  return sum / norm
}

/**
 * Build the detail texture.
 *
 * RGB holds a tangent-space normal (biased into 0..1), and A holds the height
 * field itself, which the shader reuses as a cheap large-scale albedo mottle
 * instead of running yet another fBm per pixel.
 */
export function createDetailTexture(): Texture {
  const data = new Uint8Array(SIZE * SIZE * 4)
  const octaves = 5
  // Lattice cells across the tile at the base octave.
  const cells = 8

  const heights = new Float32Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      heights[y * SIZE + x] = periodicFbm(
        (x / SIZE) * cells,
        (y / SIZE) * cells,
        octaves,
        cells,
      )
    }
  }

  // Normals by central differences, sampled with wraparound so the normals
  // themselves tile as cleanly as the heights do.
  const at = (x: number, y: number): number =>
    heights[(((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE)] as number

  // Scales the height gradient into a normal. Tuned by eye for a surface that
  // reads as rock rather than as crumpled paper.
  const strength = 2.2

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = at(x + 1, y) - at(x - 1, y)
      const dy = at(x, y + 1) - at(x, y - 1)
      let nx = -dx * strength
      let ny = -dy * strength
      const nz = 1
      const len = Math.hypot(nx, ny, nz)
      nx /= len
      ny /= len
      const i = (y * SIZE + x) * 4
      data[i] = Math.round((nx * 0.5 + 0.5) * 255)
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      data[i + 2] = Math.round((nz / len) * 255)
      data[i + 3] = Math.round((at(x, y) * 0.5 + 0.5) * 255)
    }
  }

  const texture = new DataTexture(data, SIZE, SIZE, RGBAFormat)
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.magFilter = LinearFilter
  texture.minFilter = LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}
