/**
 * Verifies the CPU/GPU noise contract.
 *
 * `src/shaders/noise.glsl` and `src/procedural/noise.ts` are two
 * implementations of the same functions, and the drone collides against the CPU
 * one while the player looks at the GPU one. This renders the GLSL versions into
 * a float render target, reads the pixels back, and compares them against the
 * TypeScript versions at the same coordinates.
 *
 * Run with the dev server up:
 *   npm run dev
 *   node tools/verify-noise-parity.mjs
 */

import puppeteer from 'puppeteer-core'

const URL = process.env.CAPTURE_URL ?? 'http://localhost:5173/'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * The integer hash must match EXACTLY — it is discrete, so any disagreement is a
 * hard discontinuity, not a rounding difference.
 *
 * The float-valued functions get a tolerance, and the number is derived rather
 * than guessed. The GPU works in float32 throughout; JS computes in float64 with
 * `Math.fround` pushing each step back to float32, which is close but not
 * bit-identical. The gap is dominated by the *coordinate*: fBm multiplies the
 * input by lacunarity each octave, so by octave 5 the coordinate magnitude is
 * ~16x larger, where float32 spacing is ~1e-4 — and value noise varies fast
 * enough that a coordinate differing in its last bit shifts the result by rather
 * more than one ulp.
 *
 * What matters is not the noise value but the *height* it produces. The largest
 * detail amplitude in surface.glsl is 3.4 m for lava, scaled by up to
 * (1 + 0.72 * 1.6) on the steepest ground, so ~8.8 m peak. A tolerance of 1e-3
 * therefore bounds the CPU/GPU height disagreement to under 9 mm — three orders
 * of magnitude below the drone's 8 m minimum ground clearance, and far below the
 * point at which anything is visible or collidable.
 *
 * If this ever needs to be tightened, the fix is fewer octaves or a smaller
 * lacunarity, not more `Math.fround` calls.
 */
const FLOAT_TOLERANCE = 1e-3

/** Peak displacement amplitude in surface.glsl, for reporting the height bound. */
const MAX_DETAIL_AMPLITUDE_M = 3.4 * (1 + 0.72 * 1.6)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--headless=new', '--use-gl=angle', '--use-angle=metal', '--no-sandbox',
         '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('page error:', e.message))
await page.goto(URL, { waitUntil: 'networkidle0', timeout: 120000 })
await page.waitForFunction(() => 'tenerife' in window, { timeout: 120000 })

const result = await page.evaluate(async (tolerance) => {
  const THREE = await import('/node_modules/three/build/three.module.js')
  const noiseGlsl = await (await fetch('/src/shaders/noise.glsl?raw&import')).text()
  const cpu = await import('/src/procedural/noise.ts')

  // The ?raw import arrives as a JS module wrapping the source in a string.
  const src = /export default "([\s\S]*)"/.exec(noiseGlsl)
    ? JSON.parse(noiseGlsl.slice(noiseGlsl.indexOf('"'), noiseGlsl.lastIndexOf('"') + 1))
    : noiseGlsl

  const SIZE = 64
  // Coordinates spanning negative and positive, and non-integer offsets, because
  // negative inputs are exactly where an int/uint conversion mismatch would show.
  const SCALE = 0.37
  const OFFSET = -740.5

  const renderer = new THREE.WebGLRenderer()
  renderer.setSize(SIZE, SIZE)
  const target = new THREE.WebGLRenderTarget(SIZE, SIZE, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
  })

  const material = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }
    `,
    fragmentShader: `
      precision highp float;
      ${src}
      varying vec2 vUv;
      uniform float uSize;
      uniform float uScale;
      uniform float uOffset;
      void main() {
        vec2 cell = floor(vUv * uSize);
        vec2 p = (cell * uScale) + uOffset;
        gl_FragColor = vec4(
          tnrf_valueNoise(p),
          tnrf_fbm(p, 5, 2.02, 0.5),
          tnrf_ridged(p, 5, 2.02, 0.5),
          float(tnrf_hash(uvec2(ivec2(cell) - 33)) & 0x00ffffffu) / 16777216.0
        );
      }
    `,
    uniforms: {
      uSize: { value: SIZE },
      uScale: { value: SCALE },
      uOffset: { value: OFFSET },
    },
  })

  const scene = new THREE.Scene()
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material))
  const camera = new THREE.Camera()
  renderer.setRenderTarget(target)
  renderer.render(scene, camera)

  const pixels = new Float32Array(SIZE * SIZE * 4)
  await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE, pixels)

  const worst = { value: 0, hash: 0, fbm: 0, ridged: 0 }
  let hashExact = true
  let samples = 0

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4
      const px = x * SCALE + OFFSET
      const py = y * SCALE + OFFSET

      worst.value = Math.max(worst.value, Math.abs(pixels[i] - cpu.valueNoise(px, py)))
      worst.fbm = Math.max(worst.fbm, Math.abs(pixels[i + 1] - cpu.fbm(px, py, 5, 2.02, 0.5)))
      worst.ridged = Math.max(worst.ridged, Math.abs(pixels[i + 2] - cpu.ridged(px, py, 5, 2.02, 0.5)))

      const expectedHash = (cpu.hash(x - 33, y - 33) & 0x00ffffff) / 16777216
      const hashDiff = Math.abs(pixels[i + 3] - expectedHash)
      worst.hash = Math.max(worst.hash, hashDiff)
      // The hash is discrete: it must land on exactly the same 24-bit value.
      if (hashDiff > 1 / 16777216) hashExact = false
      samples++
    }
  }

  renderer.dispose()
  target.dispose()
  return { worst, hashExact, samples, tolerance }
}, FLOAT_TOLERANCE)

await browser.close()

console.log(`compared ${result.samples} sample points (GPU float32 vs CPU)`)
console.log(
  `float tolerance ${FLOAT_TOLERANCE} bounds terrain height disagreement to ` +
    `${(FLOAT_TOLERANCE * MAX_DETAIL_AMPLITUDE_M * 1000).toFixed(1)} mm\n`,
)
const rows = [
  { fn: 'tnrf_hash (discrete)', 'max abs diff': result.worst.hash.toExponential(2), ok: result.hashExact },
  { fn: 'tnrf_valueNoise', 'max abs diff': result.worst.value.toExponential(2), ok: result.worst.value <= FLOAT_TOLERANCE },
  { fn: 'tnrf_fbm', 'max abs diff': result.worst.fbm.toExponential(2), ok: result.worst.fbm <= FLOAT_TOLERANCE },
  { fn: 'tnrf_ridged', 'max abs diff': result.worst.ridged.toExponential(2), ok: result.worst.ridged <= FLOAT_TOLERANCE },
]
console.table(rows)

if (rows.some((r) => !r.ok)) {
  console.error(
    `\nFAIL: noise.glsl and noise.ts disagree beyond ${FLOAT_TOLERANCE}.\n` +
    'The drone collides against the CPU version and the player sees the GPU one,\n' +
    'so this divergence shows up as the drone clipping into solid-looking rock.',
  )
  process.exit(1)
}
console.log('\nOK: the CPU and GPU noise implementations agree.')
