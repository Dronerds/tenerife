/**
 * The CPU half of the procedural noise contract.
 *
 * THIS FILE MUST MATCH `src/shaders/noise.glsl` EXACTLY. `test/noise-parity.test.ts`
 * renders the GLSL version to a float texture, reads it back, and asserts these
 * functions agree. Change one, change both.
 *
 * The reason this duplication is worth the maintenance cost: the terrain vertex
 * shader displaces the surface, and the drone collides against the CPU
 * heightfield. Without agreement the drone clips into terrain that looks solid,
 * and the cause is very hard to see from the symptom.
 *
 * `Math.fround` appears throughout to force single-precision rounding. JavaScript
 * numbers are float64; the GPU works in float32. Without the explicit rounding
 * the two drift apart in the low bits, and while that drift is small it is
 * unbounded across fBm octaves.
 */

const f32 = Math.fround

/**
 * PCG-style integer hash — the exact analogue of `tnrf_hash`.
 *
 * `Math.imul` performs a true 32-bit multiply with wraparound, matching GLSL's
 * uint arithmetic; plain `*` would overflow into float64 and diverge. `>>> 0`
 * keeps every intermediate unsigned, and `>>>` is the unsigned shift.
 */
export function hash(x: number, y: number): number {
  let h = (Math.imul(x >>> 0, 0x27d4eb2d) ^ Math.imul(y >>> 0, 0x85ebca6b)) >>> 0
  h = (h ^ (h >>> 15)) >>> 0
  h = Math.imul(h, 0x2c1b3c6d) >>> 0
  h = (h ^ (h >>> 12)) >>> 0
  h = Math.imul(h, 0x297a2d39) >>> 0
  h = (h ^ (h >>> 15)) >>> 0
  return h
}

/** Hash to [0,1), using the 24 bits a float32 represents exactly. */
export function hashToUnit(h: number): number {
  return f32((h & 0x00ffffff) / 16777216)
}

/** Value noise with a quintic fade. Matches `tnrf_valueNoise`. */
export function valueNoise(px: number, py: number): number {
  const cellX = Math.floor(px)
  const cellY = Math.floor(py)
  const fx = f32(px - cellX)
  const fy = f32(py - cellY)

  const wx = f32(fx * fx * fx * f32(fx * f32(fx * 6 - 15) + 10))
  const wy = f32(fy * fy * fy * f32(fy * f32(fy * 6 - 15) + 10))

  // `| 0` reproduces GLSL's float->int conversion, and the subsequent `>>> 0`
  // inside hash() reproduces int->uint two's-complement reinterpretation.
  const ix = cellX | 0
  const iy = cellY | 0
  const a = hashToUnit(hash(ix, iy))
  const b = hashToUnit(hash(ix + 1, iy))
  const c = hashToUnit(hash(ix, iy + 1))
  const d = hashToUnit(hash(ix + 1, iy + 1))

  const top = f32(a + f32(b - a) * wx)
  const bottom = f32(c + f32(d - c) * wx)
  return f32(top + f32(bottom - top) * wy)
}

/** Signed value noise in [-1,1]. Matches `tnrf_snoise`. */
export function snoise(px: number, py: number): number {
  return f32(f32(valueNoise(px, py) * 2) - 1)
}

/** Fractal Brownian motion. Matches `tnrf_fbm`. */
export function fbm(
  px: number,
  py: number,
  octaves: number,
  lacunarity: number,
  gain: number,
): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let x = px
  let y = py
  for (let i = 0; i < octaves; i++) {
    sum = f32(sum + f32(snoise(x, y) * amp))
    norm = f32(norm + amp)
    x = f32(x * lacunarity)
    y = f32(y * lacunarity)
    amp = f32(amp * gain)
  }
  return f32(sum / Math.max(norm, 1e-6))
}

/** Ridged multifractal — sharp crests. Matches `tnrf_ridged`. */
export function ridged(
  px: number,
  py: number,
  octaves: number,
  lacunarity: number,
  gain: number,
): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let x = px
  let y = py
  for (let i = 0; i < octaves; i++) {
    const n = f32(1 - Math.abs(snoise(x, y)))
    sum = f32(sum + f32(f32(n * n) * amp))
    norm = f32(norm + amp)
    x = f32(x * lacunarity)
    y = f32(y * lacunarity)
    amp = f32(amp * gain)
  }
  return f32(sum / Math.max(norm, 1e-6))
}
