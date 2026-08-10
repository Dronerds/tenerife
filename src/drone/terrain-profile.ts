/**
 * Terrain heights under the route, sampled once at startup.
 *
 * The three.js version kept the whole DEM resident and asked it for a height
 * three times a frame. Cesium has no equivalent: `sampleTerrainMostDetailed` is
 * async, and `globe.getHeight` returns undefined for tiles that happen not to
 * be loaded, so a per-frame query is both slow and unreliable — it would report
 * no ground exactly where the drone has just flown somewhere new.
 *
 * So the ground is resolved before the flight starts and baked into a profile
 * indexed by distance along the route. The clearance clamp then becomes a
 * synchronous lookup, deterministic and testable, with no async in the frame
 * loop at all.
 *
 * Note this samples the *globe* terrain, not any 3D tileset laid over it. With
 * the photorealistic tiles on, the visible surface can stand above the terrain
 * it was measured against.
 */

import {
  Cartesian3,
  Cartographic,
  type TerrainProvider,
  sampleTerrainMostDetailed,
} from 'cesium'

import { toCartesian } from '../geo/frame.ts'
import type { FlightRoute, Waypoint } from './route.ts'

/** Spacing of the along-route ground samples, metres. */
const STEP = 25

/** Ground heights along the route, indexed by distance travelled. */
export class GroundProfile {
  constructor(
    private readonly heights: Float64Array,
    private readonly step: number,
  ) {}

  /** Terrain height at a distance along the route, linearly interpolated. */
  groundAt(distance: number): number {
    const f = Math.max(0, distance) / this.step
    const i = Math.floor(f)
    if (i >= this.heights.length - 1) return this.heights[this.heights.length - 1] ?? 0
    const h0 = this.heights[i]!
    const h1 = this.heights[i + 1]!
    return h0 + (h1 - h0) * (f - i)
  }
}

/** Terrain height under each waypoint, in order — resolves their `agl` offsets. */
export async function sampleWaypointGround(
  provider: TerrainProvider,
  waypoints: Waypoint[],
): Promise<number[]> {
  const positions = waypoints.map((wp) => Cartographic.fromDegrees(wp.lon, wp.lat))
  await sampleTerrainMostDetailed(provider, positions)
  return positions.map((p) => p.height)
}

/** Terrain height every STEP metres along the route the waypoints produced. */
export async function sampleRouteProfile(
  provider: TerrainProvider,
  route: FlightRoute,
): Promise<GroundProfile> {
  const count = Math.ceil(route.length / STEP) + 1
  const scratch = new Cartesian3()
  const positions: Cartographic[] = []
  for (let i = 0; i < count; i++) {
    route.positionAt(i * STEP, scratch)
    positions.push(Cartographic.fromCartesian(toCartesian(scratch)))
  }
  await sampleTerrainMostDetailed(provider, positions)
  return new GroundProfile(Float64Array.from(positions, (p) => p.height), STEP)
}
