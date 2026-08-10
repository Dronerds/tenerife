/**
 * Copies Cesium's runtime assets into public/cesium.
 *
 * Cesium fetches its workers, decoders, glyph atlases and widget images by URL
 * at runtime rather than importing them, so they have to exist as static files
 * under the CESIUM_BASE_URL that vite.config.ts defines.
 *
 * public/ rather than a copy plugin: Vite serves it verbatim in dev and copies
 * it into dist on build, with no middleware ordering to get wrong. Runs from
 * postinstall, so an npm install or a Cesium upgrade refreshes it.
 */

import { cpSync, mkdirSync, rmSync } from 'node:fs'

const FROM = 'node_modules/cesium/Build/Cesium'
const TO = 'public/cesium'
const DIRS = ['Workers', 'ThirdParty', 'Assets', 'Widgets']

rmSync(TO, { recursive: true, force: true })
mkdirSync(TO, { recursive: true })
for (const dir of DIRS) {
  cpSync(`${FROM}/${dir}`, `${TO}/${dir}`, { recursive: true })
}
console.log(`cesium assets -> ${TO}/{${DIRS.join(',')}}`)
