/**
 * Entry point. Starts in FPV mode flying the demo route.
 *
 * Controls
 *   V             toggle FPV flight / free orbit
 *   space         pause the flight
 *   [ / ]         slower / faster
 *   , / .         previous / next waypoint
 *   drag/scroll   orbit and zoom, in free mode
 */

import {
  Ion,
  Math as CesiumMath,
  type PerspectiveFrustum,
  Viewer,
  createWorldTerrainAsync,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

import { DroneFlight } from './drone/flight.ts'
import { FlightRoute, ROUTE } from './drone/route.ts'
import { sampleRouteProfile, sampleWaypointGround } from './drone/terrain-profile.ts'

const hud = document.getElementById('hud') as HTMLDivElement

/**
 * Horizontal field of view.
 *
 * The three.js version used a 72° *vertical* FOV. Cesium's `fov` is the wider
 * axis, which on a landscape canvas is the horizontal one, so matching the
 * framing means 2·atan(tan(36°)·16/9) ≈ 104.5°. This is the single biggest
 * lever on why the two versions look different side by side.
 */
const FOV = CesiumMath.toRadians(104.5)

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

  const camera = viewer.camera
  // The 3D scene's frustum is always a PerspectiveFrustum; the union in the
  // types covers the 2D and Columbus View modes this app never enters.
  const frustum = camera.frustum as PerspectiveFrustum
  frustum.fov = FOV
  // 0.5 m near plane because the drone flies within metres of rock on the tight
  // turns; Cesium's logarithmic depth buffer is what makes that affordable
  // alongside a horizon-distance far plane.
  frustum.near = 0.5

  // The ground under the route, resolved before anything flies it. Two passes:
  // the waypoints first, because their `agl` offsets decide where the spline
  // goes, then the spline itself at 25 m spacing.
  hud.textContent = 'sampling terrain…'
  const started = performance.now()
  const route = new FlightRoute(await sampleWaypointGround(terrainProvider, ROUTE))
  const profile = await sampleRouteProfile(terrainProvider, route)
  console.info(
    `route: ${(route.length / 1000).toFixed(2)} km, ` +
      `ground sampled in ${((performance.now() - started) / 1000).toFixed(1)} s`,
  )

  const flight = new DroneFlight(route, profile)
  let fpv = true
  // Cesium's screen-space controller is the free-orbit camera; it has to be off
  // while the flight owns the camera or the two fight over it every frame.
  viewer.scene.screenSpaceCameraController.enableInputs = false

  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase()
    if (key === 'v') {
      fpv = !fpv
      viewer.scene.screenSpaceCameraController.enableInputs = !fpv
    } else if (event.key === ' ') {
      flight.paused = !flight.paused
      event.preventDefault()
    } else if (key === '[') {
      flight.speed = Math.max(5, flight.speed - 10)
    } else if (key === ']') {
      flight.speed = Math.min(300, flight.speed + 10)
    } else if (key === ',' || key === '.') {
      const points = flight.route.points
      let index = points.findIndex((p) => p.distance > flight.distanceTravelled)
      if (index < 0) index = points.length
      flight.seekToWaypoint(key === '.' ? index : index - 2)
    }
  })

  let fps = 0
  let last = performance.now()

  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now()
    const frameMs = Math.max(now - last, 0.001)
    last = now
    fps += (1000 / frameMs - fps) * 0.08
    // Clamp dt: a background tab or a shader compile stall produces a huge
    // delta, which would teleport the drone hundreds of metres down the route.
    const dt = Math.min(frameMs / 1000, 0.1)

    const state = fpv ? flight.update(dt, camera) : null

    const lines = [
      `${fps.toFixed(0)} fps    ${fpv ? 'FPV' : 'free'}${state?.paused ? '  [PAUSED]' : ''}`,
    ]
    if (state) {
      lines.push(
        `altitude  ${state.altitude.toFixed(0)} m   agl ${state.agl.toFixed(0)} m`,
        `waypoint  ${state.waypoint}`,
        `route     ${(state.progress * 100).toFixed(1)}%   ${state.speed.toFixed(0)} m/s`,
      )
    }
    lines.push('V fpv  space  [ ] speed  , . wp')
    hud.textContent = lines.join('\n')
  })

  Object.assign(window, { tenerife: { viewer, route, profile, flight } })
}

main().catch((error: unknown) => {
  hud.textContent = `error: ${error instanceof Error ? error.message : String(error)}`
  console.error(error)
})
