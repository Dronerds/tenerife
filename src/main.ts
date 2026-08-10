/**
 * Entry point. Orbits Punta Brava, looking inland along the coast.
 *
 * Controls
 *   V             toggle orbit / free camera
 *   space         pause the orbit
 *   [ / ]         slower / faster
 *   B             toggle buildings
 *   P             photorealistic tiles / terrain + OSM buildings
 *   drag/scroll   pan and zoom, in free mode
 */

import {
  Cartesian3,
  Cartographic,
  Ellipsoid,
  Ion,
  JulianDate,
  Math as CesiumMath,
  type PerspectiveFrustum,
  Viewer,
  createGooglePhotorealistic3DTileset,
  createOsmBuildingsAsync,
  createWorldTerrainAsync,
  sampleTerrainMostDetailed,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

import { OrbitCamera } from './camera/orbit.ts'

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

/**
 * Punta Brava, the old route's first waypoint.
 *
 * The camera starts due north of it — out over the water — so the opening view
 * looks south, inland, back along the coast. It then circles.
 */
const ORBIT = {
  lon: -16.5678,
  lat: 28.4183,
  targetHeight: 40,
  radius: 900,
  height: 320,
  startBearing: 0,
}

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
  // Freeze the sun. `enableLighting` shades from the real sun position at the
  // scene clock, which defaults to now — so the island is lit differently on
  // every run, and at night it is simply black. That makes capture-to-capture
  // comparison meaningless, which is the one thing this branch exists for.
  // Late morning in high summer, when Teide's north face is lit rather than in
  // its own shadow. The three.js version's fixed sun vector is the equivalent.
  viewer.clock.currentTime = JulianDate.fromIso8601('2024-06-21T11:00:00Z')
  viewer.clock.shouldAnimate = false

  const camera = viewer.camera
  // The 3D scene's frustum is always a PerspectiveFrustum; the union in the
  // types covers the 2D and Columbus View modes this app never enters.
  const frustum = camera.frustum as PerspectiveFrustum
  frustum.fov = FOV
  // 0.5 m near plane because the drone flies within metres of rock on the tight
  // turns; Cesium's logarithmic depth buffer is what makes that affordable
  // alongside a horizon-distance far plane.
  frustum.near = 0.5

  // Replaces the three.js version's OSM layer wholesale: 636 lines of extrusion
  // plus a 48 MB osm.json built by a Python script, for one line and no local
  // data. Same source data, same abstraction — untextured prisms from OSM
  // footprints — so the two are directly comparable. Hidden by default, since
  // the photogrammetry below already contains buildings.
  const buildings = await createOsmBuildingsAsync()
  viewer.scene.primitives.add(buildings)

  // Google Photorealistic 3D Tiles: textured photogrammetry instead of extruded
  // prisms over a shaded DEM. This is the layer that actually changes what the
  // route looks like, so it is what the app opens on.
  //
  // It is also the only metered thing here — Google bills per tile request
  // through the ion quota — so unlike everything else, simply running the app
  // now costs something. P falls back to the free stack (Cesium World Terrain
  // plus OSM buildings), which is also the like-for-like comparison against the
  // three.js version.
  hud.textContent = 'loading photorealistic tiles…'
  // Google licence: these tiles may only be used with the Google geocoder. This
  // app has no geocoder at all (the Viewer disables it), so the restriction
  // holds trivially, and this flag asserts we know about it.
  const photoreal = await createGooglePhotorealistic3DTileset({
    onlyUsingWithGoogleGeocoder: true,
  })
  viewer.scene.primitives.add(photoreal)

  let photorealOn = true

  function setPhotoreal(on: boolean): void {
    photorealOn = on
    photoreal.show = on
    // The photogrammetry already contains the ground and the buildings, so
    // drawing them underneath it would z-fight against two surfaces of its own.
    viewer.scene.globe.show = !on
    buildings.show = !on
  }

  function togglePhotoreal(): void {
    setPhotoreal(!photorealOn)
  }

  setPhotoreal(true)

  const orbit = new OrbitCamera(ORBIT)
  let orbiting = true
  // Cesium's screen-space controller is the free-orbit camera; it has to be off
  // while the flight owns the camera or the two fight over it every frame.
  viewer.scene.screenSpaceCameraController.enableInputs = false

  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase()
    if (key === 'v') {
      orbiting = !orbiting
      viewer.scene.screenSpaceCameraController.enableInputs = !orbiting
    } else if (event.key === ' ') {
      orbit.paused = !orbit.paused
      event.preventDefault()
    } else if (key === '[') {
      orbit.speed = Math.max(0.25, orbit.speed - 0.5)
    } else if (key === ']') {
      orbit.speed = Math.min(20, orbit.speed + 0.5)
    } else if (key === 'b') {
      buildings.show = !buildings.show
    } else if (key === 'p') {
      togglePhotoreal()
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

    const state = orbiting ? orbit.update(dt, camera) : null

    const lines = [
      `${fps.toFixed(0)} fps    ${orbiting ? 'orbit' : 'free'}${state?.paused ? '  [PAUSED]' : ''}`,
    ]
    if (state) {
      lines.push(
        `bearing   ${state.bearing.toFixed(0)}°   ${orbit.speed.toFixed(2)}°/s`,
        `altitude  ${orbit.altitude.toFixed(0)} m`,
      )
    }
    lines.push(
      `layer     ${photorealOn ? 'google photoreal' : 'terrain + osm buildings'}`,
      `tiles     ${settled() ? 'loaded' : 'streaming'}`,
      'V free  space  [ ] speed  B built  P photoreal',
    )
    hud.textContent = lines.join('\n')
  })

  /** True when every visible tile source has finished streaming. */
  function settled(): boolean {
    if (photorealOn) return photoreal.tilesLoaded
    return viewer.scene.globe.tilesLoaded && (!buildings.show || buildings.tilesLoaded)
  }

  // Handle for automated verification (tools/capture.mjs) and devtools poking.
  Object.assign(window, {
    tenerife: {
      viewer,
      orbit,
      buildings,
      togglePhotoreal,
      setPhotoreal,
      settled,
      setFpv(on: boolean) {
        orbiting = on
        viewer.scene.screenSpaceCameraController.enableInputs = !on
      },
      /**
       * Place the free camera at a geographic position, `agl` metres up.
       *
       * Ground comes from a one-shot terrain sample rather than the route
       * profile, because these viewpoints are deliberately off the route.
       */
      async lookFrom(
        from: { lon: number; lat: number; agl: number },
        at: { lon: number; lat: number; agl?: number },
      ) {
        orbiting = false
        viewer.scene.screenSpaceCameraController.enableInputs = true
        const [a, b] = await sampleTerrainMostDetailed(terrainProvider, [
          Cartographic.fromDegrees(from.lon, from.lat),
          Cartographic.fromDegrees(at.lon, at.lat),
        ])
        const eye = Cartesian3.fromRadians(a!.longitude, a!.latitude, a!.height + from.agl)
        const target = Cartesian3.fromRadians(
          b!.longitude,
          b!.latitude,
          b!.height + (at.agl ?? 0),
        )
        const direction = Cartesian3.normalize(
          Cartesian3.subtract(target, eye, new Cartesian3()),
          new Cartesian3(),
        )
        const up = Ellipsoid.WGS84.geodeticSurfaceNormal(eye, new Cartesian3())
        // Orthogonalise: the geodetic normal is not perpendicular to a
        // downward-looking view direction.
        Cartesian3.normalize(
          Cartesian3.subtract(
            up,
            Cartesian3.multiplyByScalar(
              direction,
              Cartesian3.dot(up, direction),
              new Cartesian3(),
            ),
            up,
          ),
          up,
        )
        camera.setView({ destination: eye, orientation: { direction, up } })
      },
      /** Resolves after the next rendered frame, so a screenshot is not mid-update. */
      nextFrame(): Promise<void> {
        return new Promise((resolve) => {
          const remove = viewer.scene.postRender.addEventListener(() => {
            remove()
            resolve()
          })
        })
      },
    },
  })
}

main().catch((error: unknown) => {
  hud.textContent = `error: ${error instanceof Error ? error.message : String(error)}`
  console.error(error)
})
