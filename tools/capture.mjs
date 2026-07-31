/**
 * Headless capture for visual verification.
 *
 * Drives the dev server through real Chrome (real GPU, real WebGL2) and shoots
 * a fixed set of viewpoints, so terrain changes can be compared frame to frame
 * rather than by spinning the camera around by hand and hoping.
 *
 * The low-AGL viewpoints are the ones that matter: this project exists to look
 * right at 15 m above the ground, and a bug that is invisible from 9 km up can
 * be glaring from 15 m.
 *
 *   npm run dev
 *   node tools/capture.mjs [outputDir]
 */

import { mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const OUT = process.argv[2] ?? 'captures'
const URL = process.env.CAPTURE_URL ?? 'http://localhost:5173/'
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

/** Debug shading modes captured for the whole-island view. */
const DEBUG_VIEWS = [
  { name: '07-quadtree-depth', key: '2' },
  { name: '08-morph-factor', key: '3' },
  { name: '09-biomes', key: '4' },
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

await page.goto(URL, { waitUntil: 'networkidle0', timeout: 120000 })
await page.waitForFunction(() => 'tenerife' in window, { timeout: 120000 })
// These viewpoints are free-camera shots, so take the drone off the controls.
await page.evaluate(() => window.tenerife.setFpv(false))

const settle = () => new Promise((r) => setTimeout(r, 900))
const hud = () => page.$eval('#hud', (el) => el.textContent)

const report = []

for (const view of VIEWS) {
  await page.evaluate(
    (from, at) => window.tenerife.lookFrom(from, at),
    view.from,
    view.at,
  )
  await settle()
  await page.screenshot({ path: `${OUT}/${view.name}.png` })
  const text = await hud()
  const nodes = /nodes\s+(\d+)/.exec(text)?.[1]
  const tris = /triangles\s+([\d.]+)/.exec(text)?.[1]
  const fps = /^(\d+) fps/.exec(text)?.[1]
  const agl = /agl\s+(-?\d+)/.exec(text)?.[1]
  const saturated = text.includes('SATURATED')
  report.push({ name: view.name, note: view.note, fps, nodes, tris, agl, saturated })
}

// Debug modes, from the whole-island viewpoint.
await page.evaluate(
  (from, at) => window.tenerife.lookFrom(from, at),
  VIEWS[0].from,
  VIEWS[0].at,
)
for (const dv of DEBUG_VIEWS) {
  await page.keyboard.press(dv.key)
  await settle()
  await page.screenshot({ path: `${OUT}/${dv.name}.png` })
}
await page.keyboard.press('1')


console.table(report)
if (errors.length) {
  console.error('\npage errors:')
  for (const e of errors.slice(0, 10)) console.error('  ' + e)
  process.exitCode = 1
}

await browser.close()
