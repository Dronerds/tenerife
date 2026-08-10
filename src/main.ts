/**
 * Entry point. Parks the camera over Teide on Cesium World Terrain.
 *
 * The flight, the route and the 3D Tiles layers land in later commits; this is
 * the viewer they all hang off.
 */

import {
  Cartesian3,
  Ion,
  Math as CesiumMath,
  Viewer,
  createWorldTerrainAsync,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

const hud = document.getElementById('hud') as HTMLDivElement

/** Pico del Teide, the same coordinates the demo route summits at. */
const TEIDE = { lon: -16.6425, lat: 28.2724 }

async function main(): Promise<void> {
  const token = import.meta.env['VITE_CESIUM_ION_TOKEN'] as string | undefined
  if (!token) {
    throw new Error('VITE_CESIUM_ION_TOKEN is not set — copy .env.example to .env.local')
  }
  Ion.defaultAccessToken = token

  hud.textContent = 'loading terrain…'
  // Vertex normals are what `globe.enableLighting` shades against; without them
  // the terrain is lit flat and reads as a painted texture rather than relief.
  const terrainProvider = await createWorldTerrainAsync({ requestVertexNormals: true })

  const viewer = new Viewer('cesiumContainer', {
    terrainProvider,
    // All of Cesium's default chrome is off — this is a flight view, not a map
    // browser. The credit container stays: ion attribution is a licence term.
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  })
  viewer.scene.globe.enableLighting = true

  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(TEIDE.lon, TEIDE.lat, 12_000),
    orientation: { heading: 0, pitch: CesiumMath.toRadians(-60), roll: 0 },
  })

  hud.textContent = 'Teide — Cesium World Terrain'
}

main().catch((error: unknown) => {
  hud.textContent = `error: ${error instanceof Error ? error.message : String(error)}`
  console.error(error)
})
