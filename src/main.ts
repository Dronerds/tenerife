/**
 * Entry point. Parks the camera over Teide on Cesium World Terrain and resolves
 * the demo route's ground profile.
 *
 * The flight and the 3D Tiles layers land in later commits; this is the viewer
 * they hang off.
 */

import {
  Cartesian3,
  Ion,
  Math as CesiumMath,
  Viewer,
  createWorldTerrainAsync,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

import { FlightRoute, ROUTE } from './drone/route.ts'
import { sampleRouteProfile, sampleWaypointGround } from './drone/terrain-profile.ts'

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

  // The ground under the route, resolved before anything flies it. Two passes:
  // the waypoints first, because their `agl` offsets decide where the spline
  // goes, then the spline itself at 25 m spacing.
  hud.textContent = 'sampling terrain…'
  const started = performance.now()
  const route = new FlightRoute(await sampleWaypointGround(terrainProvider, ROUTE))
  const profile = await sampleRouteProfile(terrainProvider, route)
  const sampleMs = performance.now() - started

  console.info(
    `route: ${(route.length / 1000).toFixed(2)} km, ` +
      `ground sampled in ${(sampleMs / 1000).toFixed(1)} s`,
  )

  Object.assign(window, { tenerife: { viewer, route, profile } })
  hud.textContent =
    `route     ${(route.length / 1000).toFixed(1)} km\n` +
    `sampled   ${(sampleMs / 1000).toFixed(1)} s\n` +
    `summit    ${profile.groundAt(route.points[15]!.distance).toFixed(0)} m at ${route.points[15]!.name}`
}

main().catch((error: unknown) => {
  hud.textContent = `error: ${error instanceof Error ? error.message : String(error)}`
  console.error(error)
})
