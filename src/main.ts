/**
 * Entry point. Opens over Punta Brava looking inland along the coast, then
 * hands the camera to the user.
 *
 * Movement is Cesium's own screen-space controller: left-drag pans, right-drag
 * or scroll zooms, middle-drag (or ctrl-drag) rotates and tilts.
 *
 * Controls
 *   B             toggle buildings
 *   P             photorealistic tiles / terrain + OSM buildings
 */

import {
  Cartesian3,
  Cartographic,
  type Cesium3DTileset,
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
import { resolveLayers } from './layers'

const hud = document.getElementById('hud') as HTMLDivElement
const loading = document.getElementById('loading') as HTMLDivElement

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
 * Opening view, over Punta Brava looking east-southeast down the coast.
 *
 * Only the starting position — the camera is the user's from the first frame.
 */
const START = {
  lon: -16.56831,
  lat: 28.40894,
  height: 91,
  heading: 117,
  pitch: -15,
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

  // Point the camera before anything is awaited. Otherwise it sits at Cesium's
  // default whole-globe home view for as long as the tilesets take to create,
  // streaming world imagery you never asked for, and then snaps to Tenerife.
  camera.setView({
    destination: Cartesian3.fromDegrees(START.lon, START.lat, START.height),
    orientation: {
      heading: CesiumMath.toRadians(START.heading),
      pitch: CesiumMath.toRadians(START.pitch),
      roll: 0,
    },
  })

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
  // It is also the only metered thing here. Billing is per session — one root
  // tileset request covers up to three hours of tile requests — so a visit costs
  // one unit regardless of how long it lasts. On the ion free tier that is 1,000
  // sessions a month and no payment path: at the cap it stops serving, it does
  // not bill. P falls back to the free stack (Cesium World Terrain plus OSM
  // buildings), which is also the like-for-like comparison against the three.js
  // version.
  hud.textContent = 'loading photorealistic tiles…'
  // Undefined when the tiles cannot be had — quota exhausted, token revoked, ion
  // unreachable. That must not take the page down with it: the free stack above
  // has already loaded and is a complete, usable view on its own. Everything
  // below here — camera, keys, the window handle — has to run either way.
  let photoreal: Cesium3DTileset | undefined
  try {
    // Google licence: these tiles may only be used with the Google geocoder.
    // This app has no geocoder at all (the Viewer disables it), so the
    // restriction holds trivially, and this flag asserts we know about it.
    photoreal = await createGooglePhotorealistic3DTileset({
      onlyUsingWithGoogleGeocoder: true,
    })
    viewer.scene.primitives.add(photoreal)
  } catch (error) {
    console.error('photorealistic tiles unavailable — falling back to the free stack', error)
  }

  let layers = resolveLayers(false, photoreal !== undefined)

  function setPhotoreal(on: boolean): void {
    layers = resolveLayers(on, photoreal !== undefined)
    if (photoreal) photoreal.show = layers.photoreal
    viewer.scene.globe.show = layers.globe
    buildings.show = layers.buildings
  }

  function togglePhotoreal(): void {
    setPhotoreal(!layers.photoreal)
  }

  setPhotoreal(true)

  // Collision detection off. Two reasons: it stops you zooming down to street
  // level, which is the point of having photogrammetry; and with the globe
  // hidden under the photorealistic tiles it pushes the camera upward on its
  // own — measured at 170 m of unrequested climb in the first seconds, against
  // 0 with it off or with the globe showing.
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = false

  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase()
    if (key === 'b') {
      buildings.show = !buildings.show
    } else if (key === 'p') {
      togglePhotoreal()
    }
  })

  let fps = 0
  let last = performance.now()
  let settledFrames = 0

  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now()
    const frameMs = Math.max(now - last, 0.001)
    last = now
    fps += (1000 / frameMs - fps) * 0.08

    // Hold the loading screen until the tiles are in. Photogrammetry arrives
    // coarsest-first, and its root tiles are enormous smeared blobs that read as
    // a broken mesh for the seconds they take to refine — this covers that
    // entirely rather than showing it. Two consecutive settled frames, because
    // tilesLoaded flickers true between request batches.
    if (!loading.hidden) {
      settledFrames = settled() ? settledFrames + 1 : 0
      if (settledFrames >= 2) loading.hidden = true
    }

    const position = Cartographic.fromCartesian(camera.positionWC)
    const lon = CesiumMath.toDegrees(position.longitude)
    const lat = CesiumMath.toDegrees(position.latitude)
    const lines = [
      `${fps.toFixed(0)} fps`,
      // Five decimals is a bit over a metre at this latitude — enough to point
      // someone at the same spot, without pretending to sub-metre accuracy.
      `lon/lat   ${lon.toFixed(5)}, ${lat.toFixed(5)}`,
      `altitude  ${position.height.toFixed(0)} m`,
      `heading   ${CesiumMath.toDegrees(camera.heading).toFixed(0)}°   ` +
        `pitch ${CesiumMath.toDegrees(camera.pitch).toFixed(0)}°`,
    ]
    lines.push(
      `layer     ${layers.label}`,
      `tiles     ${settled() ? 'loaded' : 'streaming'}`,
      'drag pan   scroll zoom   ctrl-drag rotate/tilt   B built  P photoreal',
    )
    hud.textContent = lines.join('\n')
  })

  /** True when every visible tile source has finished streaming. */
  function settled(): boolean {
    if (layers.photoreal && photoreal) return photoreal.tilesLoaded
    return viewer.scene.globe.tilesLoaded && (!buildings.show || buildings.tilesLoaded)
  }

  // Handle for automated verification (tools/capture.mjs) and devtools poking.
  Object.assign(window, {
    tenerife: {
      viewer,
      buildings,
      togglePhotoreal,
      setPhotoreal,
      settled,
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
        const [a, b] = await sampleTerrainMostDetailed(terrainProvider, [
          Cartographic.fromDegrees(from.lon, from.lat),
          Cartographic.fromDegrees(at.lon, at.lat),
        ])
        const eye = Cartesian3.fromRadians(a!.longitude, a!.latitude, a!.height + from.agl)
        const target = Cartesian3.fromRadians(b!.longitude, b!.latitude, b!.height + (at.agl ?? 0))
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
            Cartesian3.multiplyByScalar(direction, Cartesian3.dot(up, direction), new Cartesian3()),
            up,
          ),
          up,
        )
        // Collision detection off. Two reasons: it stops you zooming down to street
        // level, which is the point of having photogrammetry; and with the globe
        // hidden under the photorealistic tiles it pushes the camera upward on its
        // own — measured at 170 m of unrequested climb in the first seconds, against
        // 0 with it off or with the globe showing.
        viewer.scene.screenSpaceCameraController.enableCollisionDetection = false

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
