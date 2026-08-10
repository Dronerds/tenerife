/**
 * Headless capture for visual verification.
 *
 * Drives the dev server through real Chrome (real GPU, real WebGL2) and shoots
 * a fixed set of viewpoints, so changes can be compared frame to frame rather
 * than by spinning the camera around by hand and hoping.
 *
 * The viewpoints are the three.js version's, unchanged, so the two branches can
 * be shot into separate directories and compared image against image:
 *
 *   (in tenerife/)         npm run dev &  npm run capture captures-three
 *   (in tenerife-cesium/)  npm run dev &  npm run capture captures-cesium
 *
 *   npm run dev
 *   node tools/capture.mjs [outputDir]
 *
 * Shoots the photorealistic tiles, since that is what the app opens on. Set
 * BASELINE=1 to shoot terrain plus OSM buildings instead — the free stack, and
 * the like-for-like comparison against the three.js version.
 */

import { mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const OUT = process.argv[2] ?? 'captures'
const URL = process.env.CAPTURE_URL ?? 'http://localhost:5174/'
const BASELINE = process.env.BASELINE === '1'
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** Landmarks chosen to exercise the extremes of scale and relief. */
const VIEWS = [
  {
    name: '01-island-from-southeast',
    note: 'whole island, far field, LOD root levels',
    from: { lon: -16.35, lat: 28.02, agl: 12000 },
    at: { lon: -16.6425, lat: 28.2724 },
  },
  {
    name: '02-teide-from-canadas',
    note: 'the classic view across the caldera floor',
    from: { lon: -16.6222, lat: 28.2242, agl: 60 },
    at: { lon: -16.6425, lat: 28.2724 },
  },
  {
    name: '03-low-over-canadas',
    note: '15 m AGL — the design case',
    from: { lon: -16.6222, lat: 28.2242, agl: 15 },
    at: { lon: -16.6425, lat: 28.2724 },
  },
  {
    name: '04-anaga-ridge',
    note: 'steepest, most dissected terrain on the island',
    from: { lon: -16.2295, lat: 28.5305, agl: 20 },
    at: { lon: -16.19, lat: 28.56 },
  },
  {
    name: '05-masca-gorge',
    note: 'deep barranco — worst case for LOD popping',
    from: { lon: -16.8215, lat: 28.3, agl: 25 },
    at: { lon: -16.842, lat: 28.32 },
  },
  {
    name: '06-north-coast',
    note: 'sea cliffs and the land/water join',
    from: { lon: -16.55, lat: 28.42, agl: 300 },
    at: { lon: -16.6, lat: 28.36 },
  },
]

mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: [
    '--headless=new',
    '--use-gl=angle',
    '--use-angle=metal',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
  ],
})

const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 })

const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text())
})

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 180000 })
// Not networkidle0: Cesium streams tiles continuously, so the network never
// goes idle. Wait for the app's own handle instead.
await page.waitForFunction(() => 'tenerife' in window, { timeout: 300000, polling: 500 })
// These viewpoints are free-camera shots, so take the drone off the controls.
await page.evaluate(() => window.tenerife.setFpv(false))
if (BASELINE) await page.evaluate(() => window.tenerife.setPhotoreal(false))

/**
 * Wait until the tiles stop streaming, then for one rendered frame.
 *
 * The three.js version could get away with a fixed 900 ms here because all its
 * data was resident. Cesium streams, so the wait has to be a real predicate —
 * and `tilesLoaded` flickers true between request batches, hence the streak
 * rather than a single sample.
 */
async function settle() {
  await page.evaluate(() => {
    globalThis.__streak = 0
  })
  await page.waitForFunction(
    () => {
      globalThis.__streak = window.tenerife.settled() ? (globalThis.__streak ?? 0) + 1 : 0
      return globalThis.__streak >= 5
    },
    { polling: 250, timeout: 300000 },
  )
  await page.evaluate(() => window.tenerife.nextFrame())
}

const hud = () => page.$eval('#hud', (el) => el.textContent)
const report = []

for (const view of VIEWS) {
  await page.evaluate((from, at) => window.tenerife.lookFrom(from, at), view.from, view.at)
  await settle()
  await page.screenshot({ path: `${OUT}/${view.name}.png` })
  const text = await hud()
  report.push({
    name: view.name,
    note: view.note,
    fps: /^(\d+) fps/.exec(text)?.[1],
    layer: /layer\s+(.+)/.exec(text)?.[1],
    tiles: /tiles\s+(\w+)/.exec(text)?.[1],
  })
}

console.table(report)
if (errors.length) {
  console.error('\npage errors:')
  for (const e of errors.slice(0, 10)) console.error('  ' + e)
  process.exitCode = 1
}

await browser.close()
