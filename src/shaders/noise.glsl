/**
 * The canonical procedural noise definition.
 *
 * THIS FILE IS ONE HALF OF A CONTRACT. `src/procedural/noise.ts` is the other,
 * and `test/noise-parity.test.ts` asserts they agree. Change one, change both.
 *
 * Why it matters: the terrain vertex shader displaces the surface away from the
 * raw heightfield, but the drone collides against the CPU heightfield. If the
 * two noise implementations disagree, the drone clips into hillsides and hovers
 * above rock, and the discrepancy is nearly impossible to debug from the
 * symptom.
 *
 * The hash is built from 32-bit integer operations rather than the usual
 * `fract(sin(dot(...)))` trick, precisely so that this parity is achievable:
 * `sin` differs between GPU vendors and between GPU and CPU, whereas integer
 * multiply-xor-shift is exactly specified in both GLSL ES 3.0 and JavaScript.
 *
 * All noise is a pure function of world position. There is no per-frame state,
 * no per-tile seed and no dependence on LOD level, so a given rock sits in the
 * same place at every level of detail, from every direction, in every session.
 */

/**
 * PCG-style integer hash. Negative coordinates reach here as two's-complement
 * bit patterns via int->uint, which is exactly specified — do NOT convert a
 * negative float straight to uint, which is undefined.
 */
uint tnrf_hash(uvec2 p) {
  uint h = p.x * 0x27d4eb2du ^ p.y * 0x85ebca6bu;
  h ^= h >> 15;
  h *= 0x2c1b3c6du;
  h ^= h >> 12;
  h *= 0x297a2d39u;
  h ^= h >> 15;
  return h;
}

/** Hash to [0,1). Uses 24 bits, the exactly-representable range of a float32. */
float tnrf_hashToUnit(uint h) {
  return float(h & 0x00ffffffu) / 16777216.0;
}

/** Value noise with a quintic fade, so the first derivative is continuous. */
float tnrf_valueNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = p - cell;
  // Quintic rather than cubic: cubic smoothstep leaves visible creases along
  // cell boundaries once the result is used to displace geometry.
  vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  ivec2 i = ivec2(cell);
  float a = tnrf_hashToUnit(tnrf_hash(uvec2(i)));
  float b = tnrf_hashToUnit(tnrf_hash(uvec2(i + ivec2(1, 0))));
  float c = tnrf_hashToUnit(tnrf_hash(uvec2(i + ivec2(0, 1))));
  float d = tnrf_hashToUnit(tnrf_hash(uvec2(i + ivec2(1, 1))));

  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

/** Signed value noise in [-1,1]. */
float tnrf_snoise(vec2 p) {
  return tnrf_valueNoise(p) * 2.0 - 1.0;
}

/**
 * Fractal Brownian motion. Octave count is a compile-time constant because a
 * dynamic loop bound prevents the compiler from unrolling and costs real
 * performance in the vertex stage.
 */
float tnrf_fbm(vec2 p, const int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 1.0;
  float norm = 0.0;
  for (int i = 0; i < octaves; i++) {
    sum += tnrf_snoise(p) * amp;
    norm += amp;
    p *= lacunarity;
    amp *= gain;
  }
  return sum / max(norm, 1e-6);
}

/**
 * Ridged multifractal — sharp crests rather than rounded hills. This is what
 * gives lava fields and eroded volcanic rock their character, and it is the
 * dominant surface type above the treeline on Tenerife.
 */
float tnrf_ridged(vec2 p, const int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 1.0;
  float norm = 0.0;
  for (int i = 0; i < octaves; i++) {
    float n = 1.0 - abs(tnrf_snoise(p));
    sum += n * n * amp;
    norm += amp;
    p *= lacunarity;
    amp *= gain;
  }
  return sum / max(norm, 1e-6);
}
