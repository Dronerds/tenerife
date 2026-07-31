/**
 * OpenStreetMap roads, buildings and walls.
 *
 * This is the layer that has to be real. The DEM gives the island's shape and
 * everything finer than 30 m is synthesised, but a procedural road network over
 * a real island is immediately wrong to anyone who knows the place — and being
 * checkable against reality is the entire reason for choosing Tenerife over a
 * fictional island.
 *
 * All layers are built once into merged buffer geometries — a handful of draw
 * calls rather than 113,821 meshes. Everything is positioned against the
 * heightfield at build time, so nothing needs per-frame work.
 *
 * Buildings are deliberately **flat, untextured, and coloured by height**, in the
 * style of a Mapbox `fill-extrusion` layer. The previous version had generated
 * facade textures with windows, shutters and balconies, and it looked worse: at
 * this geometric fidelity — extruded prisms with no window recesses, no cornices
 * and no street furniture — surface detail invites a comparison with reality that
 * the geometry cannot survive. An abstract treatment reads as a deliberate
 * cartographic choice instead, and stops competing with the terrain.
 */

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshLambertMaterial,
  ShapeUtils,
  Vector2,
  type Texture,
} from 'three'

import type { Heightfield } from '../geo/heightfield.ts'
import { hash, hashToUnit } from '../procedural/noise.ts'

export interface OsmPayload {
  version: number
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  roads: { path: number[]; width: number; class: string }[]
  buildings: { ring: number[]; height: number }[]
  walls: { path: number[] }[]
  water?: { ring: number[] }[]
  waterways?: { path: number[]; width: number; class: string }[]
  /** Consumed by tools/prepare_landcover.py, not by the renderer. */
  landcover?: { ring: number[]; cover: number }[]
}

const SUPPORTED_VERSION = 1

/**
 * Height added above the bare heightfield.
 *
 * Roads and buildings are placed against `getHeightAt` (the bare FABDEM
 * surface), not `getSurfaceHeightAt` (which includes procedural displacement).
 * Two reasons: the displaced height costs an fBm evaluation per vertex and there
 * are millions of them, and real roads are cut and graded into the hillside
 * rather than draped over its every bump.
 *
 * The consequence is that on rough ground — pine forest and lava, where detail
 * amplitude reaches ~3 m — a road can be clipped by terrain detail. Suppressing
 * detail along road corridors is the correct fix and needs a rasterised road
 * mask sampled by the terrain shader; that is not built yet.
 */
const ROAD_LIFT = 0.55
const BUILDING_SINK = 0.4

/** Metres per storey, matching tools/prepare_osm.py. */
const STOREY_HEIGHT = 3.1

/**
 * Height for a building OSM does not tag — about half of them.
 *
 * Deterministic from position and footprint size, and quantised to whole storeys
 * with a small jitter on top. This exists because a single constant fallback
 * turned every terrace into one extruded slab: adjacent houses at identical
 * height with flat roofs are literally a single block, and no amount of colour
 * variation separates them. A varied roofline does.
 *
 * The footprint bias is the useful part — a 40 m2 outbuilding and a 400 m2
 * apartment block should not draw from the same distribution.
 */
/**
 * Colour by building height, in the manner of a Mapbox fill-extrusion ramp.
 *
 * Cool grey at ground level, warming through stone to gold for the tall
 * buildings. This is a legible height cue rather than a claim about materials,
 * which is the point: at this geometric fidelity an abstract scheme reads as a
 * deliberate choice, where imitation render and terracotta invites a comparison
 * the geometry loses.
 */
const RAMP: { at: number; color: number }[] = [
  { at: 0, color: 0x8d94a6 },
  { at: 40, color: 0x9aa0ae },
  { at: 120, color: 0xb3a58c },
  { at: 300, color: 0xe8b04b },
]
const rampA = new Color()
const rampB = new Color()

function heightRamp(height: number, out: Color): Color {
  if (height <= (RAMP[0] as { at: number }).at) {
    return out.setHex((RAMP[0] as { color: number }).color)
  }
  for (let i = 1; i < RAMP.length; i++) {
    const hi = RAMP[i] as { at: number; color: number }
    if (height <= hi.at) {
      const lo = RAMP[i - 1] as { at: number; color: number }
      const t = (height - lo.at) / (hi.at - lo.at)
      rampA.setHex(lo.color)
      rampB.setHex(hi.color)
      return out.copy(rampA).lerp(rampB, t)
    }
  }
  return out.setHex((RAMP[RAMP.length - 1] as { color: number }).color)
}

function guessHeight(h: number, area: number): number {
  const roll = hashToUnit(hash(h, 0x5bd1e995))
  let storeys: number
  if (area < 55) {
    // Sheds, garages, outbuildings: almost always single storey.
    storeys = roll < 0.82 ? 1 : 2
  } else if (area < 190) {
    // The typical Canarian house: one or two storeys, occasionally three.
    storeys = roll < 0.34 ? 1 : roll < 0.82 ? 2 : 3
  } else if (area < 600) {
    storeys = roll < 0.2 ? 2 : roll < 0.68 ? 3 : 4
  } else {
    // Large footprints are apartment blocks, hotels and commercial sheds.
    storeys = roll < 0.25 ? 2 : roll < 0.55 ? 4 : roll < 0.85 ? 6 : 9
  }
  // Sub-storey jitter so rooflines along a terrace do not align exactly even
  // when neighbours happen to share a storey count.
  const jitter = (hashToUnit(hash(h, 0x27d4eb2d)) - 0.5) * 0.9
  return storeys * STOREY_HEIGHT + jitter
}

export interface OsmStats {
  roads: number
  buildings: number
  walls: number
  water: number
  waterways: number
  triangles: number
  buildMs: number
}

export class OsmLayer {
  readonly group = new Group()
  readonly stats: OsmStats = {
    roads: 0,
    buildings: 0,
    walls: 0,
    water: 0,
    waterways: 0,
    triangles: 0,
    buildMs: 0,
  }

  private readonly meshes: Mesh[] = []
  private readonly textures: Texture[] = []

  /**
   * Coarse record of which ground is built on.
   *
   * A sparse Set of packed cell keys rather than a dense grid: buildings cover a
   * small fraction of an 84 x 69 km island, and a dense byte grid at this
   * resolution would be tens of megabytes to store mostly zeroes.
   *
   * Vegetation consults this so trees do not grow out of roofs — which they
   * visibly did, because the scatter had no idea buildings existed.
   */
  private readonly occupied = new Set<number>()

  constructor(payload: OsmPayload, heightfield: Heightfield) {
    if (payload.version !== SUPPORTED_VERSION) {
      throw new Error(
        `osm payload version ${payload.version} is not supported ` +
          `(expected ${SUPPORTED_VERSION}) — re-run tools/prepare_osm.py`,
      )
    }

    const started = performance.now()
    this.markOccupancy(payload.buildings)
    this.buildRoads(payload.roads, heightfield)
    this.buildBuildings(payload.buildings, heightfield)
    this.buildWalls(payload.walls, heightfield)
    this.buildWater(payload, heightfield)
    this.stats.buildMs = performance.now() - started
  }

  /** Cell size of the occupancy grid, metres. */
  private static readonly OCCUPANCY_CELL = 9

  /** Pack a cell coordinate pair into one integer key. */
  private static key(col: number, row: number): number {
    // Offset into positive space before packing; local coordinates are signed.
    return ((col + 16384) << 15) | (row + 16384)
  }

  private markOccupancy(buildings: OsmPayload['buildings']): void {
    const cell = OsmLayer.OCCUPANCY_CELL
    for (const building of buildings) {
      const count = building.ring.length / 2
      if (count < 3) continue
      let minX = Infinity
      let maxX = -Infinity
      let minZ = Infinity
      let maxZ = -Infinity
      for (let i = 0; i < count; i++) {
        const x = building.ring[i * 2] as number
        const z = building.ring[i * 2 + 1] as number
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
      // Bounding box rather than the true footprint: it over-claims a little at
      // the corners of L-shaped buildings, which is the safe direction to err.
      const c0 = Math.floor(minX / cell)
      const c1 = Math.floor(maxX / cell)
      const r0 = Math.floor(minZ / cell)
      const r1 = Math.floor(maxZ / cell)
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) this.occupied.add(OsmLayer.key(c, r))
      }
    }
  }

  /** True if a point falls on a building footprint. */
  isBuiltOn(x: number, z: number): boolean {
    const cell = OsmLayer.OCCUPANCY_CELL
    return this.occupied.has(
      OsmLayer.key(Math.floor(x / cell), Math.floor(z / cell)),
    )
  }

  static async load(baseUrl: string, heightfield: Heightfield): Promise<OsmLayer> {
    const res = await fetch(`${baseUrl}/osm.json`)
    if (!res.ok) {
      throw new Error(
        `could not load ${baseUrl}/osm.json (${res.status}) — run tools/prepare_osm.py`,
      )
    }
    return new OsmLayer((await res.json()) as OsmPayload, heightfield)
  }

  /**
   * Roads, drawn as a dark casing with a lighter fill inset on top.
   *
   * This is the standard cartographic treatment and the reason map roads read so
   * much better than a single flat ribbon: the casing gives every road an edge,
   * which separates it from the ground and from adjacent roads at a junction. A
   * plain ribbon of asphalt colour just dissolves into dark terrain.
   *
   * Joins are butt ends rather than mitred: at these widths and viewing distances
   * the gap is invisible, and mitring 52,000 polylines correctly is a lot of code
   * for no visible gain.
   */
  private buildRoads(roads: OsmPayload['roads'], heightfield: Heightfield): void {
    const casing: number[] = []
    const casingN: number[] = []
    const fill: number[] = []
    const fillN: number[] = []

    const ribbon = (
      path: number[],
      halfWidth: number,
      lift: number,
      out: number[],
      outN: number[],
    ): void => {
      const n = path.length / 2
      for (let i = 0; i < n - 1; i++) {
        const ax = path[i * 2] as number
        const az = path[i * 2 + 1] as number
        const bx = path[(i + 1) * 2] as number
        const bz = path[(i + 1) * 2 + 1] as number
        let dx = bx - ax
        let dz = bz - az
        const len = Math.hypot(dx, dz)
        // Degenerate segments exist in OSM where two nodes coincide.
        if (len < 0.01) continue
        dx /= len
        dz /= len
        const px = -dz * halfWidth
        const pz = dx * halfWidth
        const ay = heightfield.getHeightAt(ax, az) + lift
        const by = heightfield.getHeightAt(bx, bz) + lift
        out.push(
          ax - px, ay, az - pz,
          ax + px, ay, az + pz,
          bx + px, by, bz + pz,
          ax - px, ay, az - pz,
          bx + px, by, bz + pz,
          bx - px, by, bz - pz,
        )
        for (let k = 0; k < 6; k++) outN.push(0, 1, 0)
      }
    }

    for (const road of roads) {
      if (road.path.length < 4) continue
      // Casing extends past the carriageway; the fill sits inside it.
      ribbon(road.path, road.width / 2 + 0.9, ROAD_LIFT, casing, casingN)
      ribbon(road.path, road.width / 2, ROAD_LIFT + 0.06, fill, fillN)
      this.stats.roads++
    }

    this.addMesh(casing, casingN, null, new Color(0x1e1c1b), -4)
    this.addMesh(fill, fillN, null, new Color(0x413e3b), -6)
  }

  /**
   * Open water, and the barranco channels that define Tenerife's slopes.
   *
   * The barrancos are the point of this layer. They are dry gorges radiating off
   * the massif, mapped as intermittent streams, and they are one of the strongest
   * organising features of the real landscape — the terrain has the gorges but
   * nothing marked where the channel runs.
   */
  private buildWater(payload: OsmPayload, heightfield: Heightfield): void {
    const positions: number[] = []
    const normals: number[] = []
    const contour: Vector2[] = []

    for (const poly of payload.water ?? []) {
      const count = poly.ring.length / 2
      if (count < 3) continue
      contour.length = 0
      let y = -Infinity
      for (let i = 0; i < count; i++) {
        const x = poly.ring[i * 2] as number
        const z = poly.ring[i * 2 + 1] as number
        contour.push(new Vector2(x, z))
        // Standing water is level: take the highest terrain sample on the ring so
        // the surface does not sink into a sloping bank.
        y = Math.max(y, heightfield.getHeightAt(x, z))
      }
      const faces = ShapeUtils.triangulateShape(contour, [])
      for (const face of faces) {
        for (let k = 2; k >= 0; k--) {
          const v = contour[face[k] as number] as Vector2
          positions.push(v.x, y + 0.3, v.y)
          normals.push(0, 1, 0)
        }
      }
      this.stats.water++
    }

    // Channels follow the ground rather than being level.
    for (const way of payload.waterways ?? []) {
      const n = way.path.length / 2
      if (n < 2) continue
      const half = way.width / 2
      for (let i = 0; i < n - 1; i++) {
        const ax = way.path[i * 2] as number
        const az = way.path[i * 2 + 1] as number
        const bx = way.path[(i + 1) * 2] as number
        const bz = way.path[(i + 1) * 2 + 1] as number
        let dx = bx - ax
        let dz = bz - az
        const len = Math.hypot(dx, dz)
        if (len < 0.01) continue
        dx /= len
        dz /= len
        const px = -dz * half
        const pz = dx * half
        const ay = heightfield.getHeightAt(ax, az) + 0.35
        const by = heightfield.getHeightAt(bx, bz) + 0.35
        positions.push(
          ax - px, ay, az - pz,
          ax + px, ay, az + pz,
          bx + px, by, bz + pz,
          ax - px, ay, az - pz,
          bx + px, by, bz + pz,
          bx - px, by, bz - pz,
        )
        for (let k = 0; k < 6; k++) normals.push(0, 1, 0)
      }
      this.stats.waterways++
    }

    this.addMesh(positions, normals, null, new Color(0x33586b), -5)
  }

  /** Build one merged mesh. `colors` null means use a flat material colour. */
  private addMesh(
    positions: number[],
    normals: number[],
    colors: number[] | null,
    color: Color | null,
    polygonOffset?: number,
  ): void {
    if (positions.length === 0) return
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
    if (colors) geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))

    const material = new MeshLambertMaterial({
      side: DoubleSide,
      ...(colors ? { vertexColors: true } : { color: color ?? new Color(0xffffff) }),
      ...(polygonOffset !== undefined
        ? {
            // Flat overlays sit within a metre of the terrain they lie on;
            // without a depth offset they z-fight along their whole length.
            polygonOffset: true,
            polygonOffsetFactor: polygonOffset,
            polygonOffsetUnits: polygonOffset,
          }
        : {}),
    })
    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    this.group.add(mesh)
    this.meshes.push(mesh)
    this.stats.triangles += positions.length / 9
  }

  /**
   * Buildings as flat extruded prisms, coloured by height.
   *
   * The ramp runs cool grey at ground level through warm stone to gold for
   * towers, which reads as a legible height cue rather than as an attempt at real
   * materials. Walls also carry a vertical gradient, darker at the base — cheap,
   * and it separates a building from the ground and from its neighbours far more
   * effectively than the window textures it replaced.
   */
  private buildBuildings(
    buildings: OsmPayload['buildings'],
    heightfield: Heightfield,
  ): void {
    const positions: number[] = []
    const normals: number[] = []
    const colors: number[] = []

    const contour: Vector2[] = []
    const tint = new Color()

    for (const building of buildings) {
      const count = building.ring.length / 2
      if (count < 3) continue

      let cx = 0
      let cz = 0
      let minX = Infinity
      let maxX = -Infinity
      let minZ = Infinity
      let maxZ = -Infinity
      for (let i = 0; i < count; i++) {
        const x = building.ring[i * 2] as number
        const z = building.ring[i * 2 + 1] as number
        cx += x
        cz += z
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
      cx /= count
      cz /= count

      // Ground the whole footprint at one height, taken at its centroid. Real
      // buildings have level floors; sampling the terrain per corner makes them
      // lean, which reads as a bug from the air.
      const base = heightfield.getHeightAt(cx, cz) - BUILDING_SINK
      // Skip anything the DEM says is at sea; these are jetties and rafts in the
      // data that would otherwise float.
      if (base < -1) continue

      const h = hash(Math.round(cx), Math.round(cz))
      const footprintArea = (maxX - minX) * (maxZ - minZ)
      // height 0 means OSM had neither a height nor a levels tag — about half of
      // them. See guessHeight for why a single constant fallback is not viable.
      const height =
        building.height > 0 ? building.height : guessHeight(h, footprintArea)
      const top = base + height

      heightRamp(height, tint)
      // Slight per-building variation so a terrace of equal-height houses is not
      // one uniform colour even where the ramp gives them the same value.
      const vary = 0.94 + 0.12 * hashToUnit(hash(h, 7))

      // Walls.
      for (let i = 0; i < count; i++) {
        const ax = building.ring[i * 2] as number
        const az = building.ring[i * 2 + 1] as number
        const j = (i + 1) % count
        const bx = building.ring[j * 2] as number
        const bz = building.ring[j * 2 + 1] as number

        let dx = bx - ax
        let dz = bz - az
        const len = Math.hypot(dx, dz)
        if (len < 0.01) continue
        dx /= len
        dz /= len
        const nx = -dz
        const nz = dx

        positions.push(
          ax, base, az,
          bx, base, bz,
          bx, top, bz,
          ax, base, az,
          bx, top, bz,
          ax, top, az,
        )
        for (let k = 0; k < 6; k++) normals.push(nx, 0, nz)
        // Vertical gradient: the six vertices above are in the order
        // base, base, top, base, top, top.
        const lo = vary * 0.66
        const hi = vary
        for (const g of [lo, lo, hi, lo, hi, hi]) {
          colors.push(tint.r * g, tint.g * g, tint.b * g)
        }
      }

      // Roof, by ear-clipping triangulation.
      //
      // A fan from the centroid is cheaper but only correct for *convex*
      // footprints, and urban buildings are mostly L-shaped or worse. On a
      // concave ring the fan emits triangles that fold outside the footprint and
      // intersect the walls, which from above reads as dark streaky mess.
      contour.length = 0
      for (let i = 0; i < count; i++) {
        contour.push(
          new Vector2(building.ring[i * 2] as number, building.ring[i * 2 + 1] as number),
        )
      }
      const faces = ShapeUtils.triangulateShape(contour, [])
      // triangulateShape winds for a Y-up 2D plane; our contour is XZ, so the
      // winding is reversed relative to an upward-facing normal.
      for (const face of faces) {
        for (let k = 2; k >= 0; k--) {
          const v = contour[face[k] as number] as Vector2
          positions.push(v.x, top, v.y)
          normals.push(0, 1, 0)
          colors.push(tint.r * vary, tint.g * vary, tint.b * vary)
        }
      }
      this.stats.buildings++
    }

    this.addMesh(positions, normals, colors, null)
  }

  /**
   * Dry-stone and terrace walls.
   *
   * Worth having because Tenerife's cultivated slopes are covered in them and
   * they read strongly from low altitude — they are one of the clearest signals
   * that a hillside is worked rather than wild.
   */
  private buildWalls(walls: OsmPayload['walls'], heightfield: Heightfield): void {
    const positions: number[] = []
    const normals: number[] = []
    const height = 1.5
    const thickness = 0.45

    for (const wall of walls) {
      const n = wall.path.length / 2
      if (n < 2) continue
      for (let i = 0; i < n - 1; i++) {
        const ax = wall.path[i * 2] as number
        const az = wall.path[i * 2 + 1] as number
        const bx = wall.path[(i + 1) * 2] as number
        const bz = wall.path[(i + 1) * 2 + 1] as number

        let dx = bx - ax
        let dz = bz - az
        const len = Math.hypot(dx, dz)
        if (len < 0.01) continue
        dx /= len
        dz /= len
        const px = -dz * thickness
        const pz = dx * thickness

        const ay = heightfield.getHeightAt(ax, az)
        const by = heightfield.getHeightAt(bx, bz)

        // Two faces plus a cap; enough to read as a wall in silhouette.
        for (const s of [-1, 1]) {
          positions.push(
            ax + px * s, ay, az + pz * s,
            bx + px * s, by, bz + pz * s,
            bx + px * s, by + height, bz + pz * s,
            ax + px * s, ay, az + pz * s,
            bx + px * s, by + height, bz + pz * s,
            ax + px * s, ay + height, az + pz * s,
          )
          for (let k = 0; k < 6; k++) normals.push(-dz * s, 0, dx * s)
        }
        positions.push(
          ax - px, ay + height, az - pz,
          ax + px, ay + height, az + pz,
          bx + px, by + height, bz + pz,
          ax - px, ay + height, az - pz,
          bx + px, by + height, bz + pz,
          bx - px, by + height, bz - pz,
        )
        for (let k = 0; k < 6; k++) normals.push(0, 1, 0)
      }
      this.stats.walls++
    }

    if (positions.length === 0) return
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
    const mesh = new Mesh(
      geometry,
      new MeshLambertMaterial({ color: new Color(0x6e6459), side: DoubleSide }),
    )
    mesh.frustumCulled = false
    this.group.add(mesh)
    this.meshes.push(mesh)
    this.stats.triangles += positions.length / 9
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  dispose(): void {
    for (const texture of this.textures) texture.dispose()
    for (const mesh of this.meshes) {
      mesh.geometry.dispose()
      ;(mesh.material as MeshLambertMaterial).dispose()
    }
  }
}
