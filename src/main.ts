/**
 * Entry point. Starts in FPV mode flying the demo route.
 *
 * Controls
 *   V             toggle FPV flight / free orbit
 *   space         pause the flight
 *   [ / ]         slower / faster
 *   , / .         previous / next waypoint
 *   1 2 3 4       materials | quadtree depth | morph factor | biome
 *   D             toggle procedural surface detail (to see what it contributes)
 *   drag/scroll   orbit and zoom, in free mode
 */

import {
  DirectionalLight,
  HemisphereLight,
  NoToneMapping,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three'
import { MapControls } from 'three/examples/jsm/controls/MapControls.js'

import { Heightfield } from './geo/heightfield.ts'
import { LandCover } from './geo/landcover.ts'
import { Imagery } from './geo/imagery.ts'
import { lonLatToLocal } from './geo/origin.ts'
import { Terrain, DEBUG_MODE_ORDER, type DebugMode } from './terrain/terrain.ts'
import { DroneFlight } from './drone/flight.ts'
import { createSea } from './sky/sea.ts'
import { HAZE_COLOR, createFog } from './sky/atmosphere.ts'
import { SkyDome } from './sky/sky-dome.ts'
import { CloudSea } from './sky/cloud-sea.ts'
import { BIOME_NAMES } from './procedural/surface.ts'
import { Vegetation } from './vegetation/instancer.ts'
import { OsmLayer } from './osm/osm-layer.ts'

const hud = document.getElementById('hud') as HTMLDivElement

async function main(): Promise<void> {
  hud.textContent = 'loading terrain data…'
  const [heightfield, landCover, imagery] = await Promise.all([
    Heightfield.load('/data'),
    LandCover.load('/data'),
    // Optional: renders fine without it, with procedural colour everywhere.
    Imagery.tryLoad('/data'),
  ])
  // Attach immediately: without it every CPU biome query falls back to
  // elevation-only guesses and silently disagrees with the shader, which always
  // has the cover texture.
  heightfield.setLandCover(landCover)

  const renderer = new WebGLRenderer({
    antialias: true,
    // The view spans metres to tens of kilometres in one frame; without a
    // logarithmic depth buffer the far terrain z-fights badly.
    logarithmicDepthBuffer: true,
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  // Deliberately no tone mapping yet. The shading is authored directly in
  // display range, and ACES desaturates it badly for no benefit. Tone mapping
  // belongs with the real HDR sun-and-sky model in M8 — the terrain shader
  // already carries the `tonemapping_fragment` hook for that, which compiles to
  // nothing while this is NoToneMapping.
  renderer.toneMapping = NoToneMapping
  // Shadows. The single largest contributor to close-range realism here: with no
  // occlusion at all, streets, forest floors and building faces are lit
  // identically regardless of what stands over them.
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFSoftShadowMap
  document.body.appendChild(renderer.domElement)

  const scene = new Scene()
  // Clear colour behind the sky dome; visible only before the dome compiles.
  scene.background = HAZE_COLOR
  // Fogs the sea plane with the same curve the terrain shader applies by hand.
  scene.fog = createFog()

  // Near plane at 0.5 m because the drone flies within metres of rock; the log
  // depth buffer is what makes that affordable alongside a 400 km far plane.
  const camera = new PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.5, 400_000)

  const controls = new MapControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  // Deliberately *not* the usual map-controls clamp just below the horizon.
  // That forbids the camera from sitting lower than its target, which here
  // means you cannot stand on the caldera floor and look up at Teide — the
  // controls silently shove the camera into the sky instead.
  controls.minPolarAngle = 0.01
  controls.maxPolarAngle = Math.PI - 0.01
  controls.minDistance = 20
  controls.maxDistance = 160_000
  controls.enabled = false

  scene.add(createSea())
  const terrain = new Terrain(heightfield, landCover, imagery)
  // Terrain receives but does not cast: casting would need a custom depth
  // material replicating the vertex displacement, and self-shadowed terrain at
  // this DEM resolution mostly produces acne rather than useful occlusion.
  terrain.mesh.receiveShadow = true
  scene.add(terrain.mesh)

  // Vegetation uses built-in Lambert materials, so unlike the terrain (which
  // lights itself in its own shader) it needs real lights in the scene. The
  // direction here must match the terrain shader's uSunDirection or the plants
  // are lit from a different sun than the ground they stand on.
  const SUN = new Vector3(0.45, 0.72, 0.53).normalize()
  const sun = new DirectionalLight(0xfff4e0, 2.1)
  sun.position.copy(SUN)
  sun.castShadow = true
  // The shadow camera covers a box around the drone rather than the island. A
  // single map spanning 84 km would give metre-scale texels — useless. This
  // covers the near field, which is the only place shadows are legible anyway,
  // and is repositioned every frame below.
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = 1600
  sun.shadow.camera.left = -320
  sun.shadow.camera.right = 320
  sun.shadow.camera.top = 320
  sun.shadow.camera.bottom = -320
  // Slope-scaled bias: terrain is near-grazing to this sun over much of the
  // island, where a constant bias either peters or leaves acne.
  sun.shadow.bias = -0.0006
  sun.shadow.normalBias = 1.2
  scene.add(sun)
  scene.add(sun.target)
    // Sky fill. Kept modest and only slightly blue: at 0.9 with a saturated sky
  // colour it turned every whitewashed wall blue-grey, which is the opposite of
  // how Canarian towns read in sunlight.
  scene.add(new HemisphereLight(0xc2d2e4, 0x6b5c49, 0.8))
  terrain.setSunDirection(SUN)

  const sky = new SkyDome()
  sky.setSunDirection(SUN)
  scene.add(sky.mesh)

  // The mar de nubes. Renders after the opaque terrain via its own renderOrder.
  const clouds = new CloudSea(heightfield)
  clouds.setSunDirection(SUN)
  scene.add(clouds.group)

  const vegetation = new Vegetation(heightfield)
  vegetation.group.traverse((o) => {
    o.castShadow = true
    o.receiveShadow = true
  })
  scene.add(vegetation.group)

  // OSM is built synchronously into merged geometry — one pause at load rather
  // than hitches during flight. It needs the heightfield to sit on, so it comes
  // after that has loaded.
  hud.textContent = 'building roads and buildings…'
  const osm = await OsmLayer.load('/data', heightfield)
  osm.group.traverse((o) => {
    o.castShadow = true
    o.receiveShadow = true
  })
  scene.add(osm.group)
  // Now that footprints are known, keep vegetation off them.
  vegetation.setBuildingMask((x, z) => osm.isBuiltOn(x, z))
  console.info(
    `osm: ${osm.stats.buildings.toLocaleString()} buildings, ` +
      `${osm.stats.roads.toLocaleString()} roads, ` +
      `${osm.stats.walls.toLocaleString()} walls, ` +
      `${osm.stats.water.toLocaleString()} water, ` +
      `${osm.stats.waterways.toLocaleString()} waterways, ` +
      `${(osm.stats.triangles / 1e6).toFixed(2)} M triangles, ` +
      `built in ${osm.stats.buildMs.toFixed(0)} ms`,
  )

  const flight = new DroneFlight(heightfield)

  let fpv = true
  let debugMode: DebugMode = 'materials'
  let detail = true
  let plants = true
  let cloudLevel = 2
  let built = true
  let satellite = imagery !== null

  /** Park the orbit camera where the drone currently is, so V does not teleport. */
  const syncOrbitToCamera = (): void => {
    const target = new Vector3()
    camera.getWorldDirection(target)
    controls.target.copy(camera.position).addScaledVector(target, 400)
  }

  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase()
    if (key === 'v') {
      fpv = !fpv
      if (!fpv) syncOrbitToCamera()
      controls.enabled = !fpv
    } else if (event.key === ' ') {
      flight.paused = !flight.paused
      event.preventDefault()
    } else if (key === '[') {
      flight.speed = Math.max(5, flight.speed - 10)
    } else if (key === ']') {
      flight.speed = Math.min(300, flight.speed + 10)
    } else if (key === 'd') {
      detail = !detail
      terrain.setDetailScale(detail ? 1 : 0)
    } else if (key === 'g') {
      plants = !plants
      vegetation.setVisible(plants)
    } else if (key === 'i') {
      satellite = !satellite
      terrain.setImageryBlend(satellite ? 1 : 0)
    } else if (key === 'b') {
      built = !built
      osm.setVisible(built)
    } else if (key === 'c') {
      // Cycles clear / partial / full deck, because the cloud sea hides exactly
      // the terrain you often want to inspect.
      cloudLevel = (cloudLevel + 1) % 3
      clouds.setCoverage([0, 0.55, 1][cloudLevel]!)
    } else if (key === ',' || key === '.') {
      const points = flight.route.points
      let index = points.findIndex((p) => p.distance > flight.distanceTravelled)
      if (index < 0) index = points.length
      flight.seekToWaypoint(key === '.' ? index : index - 2)
    } else {
      const n = Number(event.key)
      if (n >= 1 && n <= DEBUG_MODE_ORDER.length) {
        debugMode = DEBUG_MODE_ORDER[n - 1]!
        terrain.setDebugMode(debugMode)
      }
      return
    }
  })

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  // Handle for automated verification (tools/capture.mjs) and devtools poking.
  Object.assign(window, {
    tenerife: {
      camera,
      controls,
      terrain,
      heightfield,
      flight,
      vegetation,
      clouds,
      osm,
      sky,
      setFpv(on: boolean) {
        fpv = on
        controls.enabled = !on
      },
      setDebugMode(mode: DebugMode) {
        debugMode = mode
        terrain.setDebugMode(mode)
      },
      /** Jump the flight to a fraction of the route, 0..1. */
      seekTo(fraction: number) {
        flight.seekTo(fraction)
      },
      seekToWaypoint(index: number) {
        flight.seekToWaypoint(index)
      },
      /** Place the free camera at a geographic position, `agl` metres up. */
      lookFrom(
        from: { lon: number; lat: number; agl: number },
        at: { lon: number; lat: number; agl?: number },
      ) {
        fpv = false
        controls.enabled = true
        const a = lonLatToLocal(from)
        const b = lonLatToLocal(at)
        camera.position.set(a.x, heightfield.getHeightAt(a.x, a.z) + from.agl, a.z)
        controls.target.set(b.x, heightfield.getHeightAt(b.x, b.z) + (at.agl ?? 0), b.z)
        controls.update()
      },
    },
  })

  let fps = 0
  let last = performance.now()
  const probe = new Vector3()
  const sunTrack = new Vector3()

  renderer.setAnimationLoop(() => {
    const now = performance.now()
    const frameMs = Math.max(now - last, 0.001)
    last = now
    fps += (1000 / frameMs - fps) * 0.08
    // Clamp dt: a background tab or a shader compile stall produces a huge
    // delta, which would teleport the drone hundreds of metres down the route.
    const dt = Math.min(frameMs / 1000, 0.1)

    const state = fpv ? flight.update(dt, camera) : null
    if (!fpv) controls.update()

    camera.updateMatrixWorld()
    camera.updateProjectionMatrix()
    terrain.update(camera)
    if (plants) vegetation.update(camera)
    sky.update(camera)
    clouds.update(dt, camera)

    // Keep the shadow volume centred ahead of the drone. Following the camera
    // exactly wastes half the map behind it.
    camera.getWorldDirection(sunTrack).setY(0).normalize()
    sunTrack.multiplyScalar(140).add(camera.position)
    sun.target.position.copy(sunTrack)
    sun.position.copy(sunTrack).addScaledVector(SUN, 900)
    sun.target.updateMatrixWorld()
    sun.updateMatrixWorld()

    renderer.render(scene, camera)

    camera.getWorldPosition(probe)
    const ground = heightfield.getSurfaceHeightAt(probe.x, probe.z)
    const biome = BIOME_NAMES[heightfield.getBiomeAt(probe.x, probe.z)] ?? '?'
    const { nodes, triangles, saturated } = terrain.stats

    const lines = [
      `${fps.toFixed(0)} fps    ${fpv ? 'FPV' : 'free'}${state?.paused ? '  [PAUSED]' : ''}`,
      `mode      ${debugMode}${detail ? '' : '   [detail off]'}`,
      `nodes     ${nodes}${saturated ? '  ** SATURATED **' : ''}`,
      `triangles ${(triangles / 1e6).toFixed(2)} M`,
      `altitude  ${probe.y.toFixed(0)} m   agl ${(probe.y - ground).toFixed(0)} m`,
      `biome     ${biome}`,
      `plants    ${plants ? vegetation.stats.instances.toLocaleString() : 'off'}` +
        `${vegetation.stats.saturated ? '  ** CAPPED **' : ''}`,
      `clouds    ${['clear', 'partial', 'full'][cloudLevel]}`,
      `imagery   ${imagery ? (satellite ? `${imagery.manifest.scenes.length} scenes` : 'off') : 'not generated'}`,
      `osm       ${built ? `${osm.stats.buildings.toLocaleString()} bldg / ${osm.stats.roads.toLocaleString()} road` : 'off'}`,
    ]
    if (state) {
      lines.push(
        `waypoint  ${state.waypoint}`,
        `route     ${(state.progress * 100).toFixed(1)}%   ${state.speed.toFixed(0)} m/s`,
      )
    }
    lines.push('V fpv  space  [ ] speed  , . wp  1-4 mode  D detail  G plants  C clouds  B built  I imagery')
    hud.textContent = lines.join('\n')
  })
}

main().catch((error: unknown) => {
  hud.textContent = `error: ${error instanceof Error ? error.message : String(error)}`
  console.error(error)
})
