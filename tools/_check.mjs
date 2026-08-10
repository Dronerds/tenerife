import puppeteer from 'puppeteer-core'
const b = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'shell',
  args: ['--headless=new','--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox'],
})
const p = await b.newPage()
await p.setViewport({ width: 1280, height: 720 })
await p.goto('http://localhost:5174/', { waitUntil: 'domcontentloaded', timeout: 180000 })
// No key presses at all. Just load it and wait.
await p.waitForFunction(() => window.tenerife?.settled?.() === true, { timeout: 300000, polling: 500 })
await new Promise(r => setTimeout(r, 8000))
await p.screenshot({ path: process.env.SHOT })
console.log(await p.$eval('#hud', e => e.textContent))
await b.close()
