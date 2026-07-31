/**
 * The island-local coordinate system.
 *
 * Everything in the renderer works in **metres relative to a fixed origin near
 * the centre of Tenerife**, with 1 world unit = 1 metre and +Y up.
 *
 * Why not raw UTM: northings around Tenerife are ~3.13e6. float32 carries ~7
 * significant decimal digits, which at that magnitude leaves ~0.25 m of
 * representable precision — enough to produce visible vertex jitter and
 * z-fighting once you are flying 15 m above the ground. Subtracting the origin
 * keeps every coordinate inside +/-50 km, where float32 resolves to ~4 mm.
 *
 * These constants are a contract with the Python prep pipeline in `tools/`,
 * which writes rasters already expressed in this frame. **Changing them
 * invalidates every generated asset.**
 */

import { lonLatToUtm28n, utm28nToLonLat } from './projection.ts'
import type { LonLat } from './projection.ts'

/**
 * UTM 28N easting of the local origin, metres.
 *
 * Chosen as a round number near lon -16.60, lat 28.29 — roughly the island's
 * centroid, inland of Granadilla.
 */
export const ORIGIN_EAST = 343000

/** UTM 28N northing of the local origin, metres. */
export const ORIGIN_NORTH = 3130000

/**
 * The height grid, in island-local metres.
 *
 * Covers lon -16.95..-16.10, lat 27.98..28.61 — the whole island including the
 * Anaga peninsula, with a little margin. Sample (0,0) sits exactly at
 * (`GRID.minX`, `GRID.minZ`) and samples are spaced `GRID.resolution` apart, so
 * the last sample is at `minX + (width - 1) * resolution`.
 *
 * `tools/prepare_heights.py` reads these same numbers and resamples the source
 * DEM onto exactly this grid. The manifest it emits is the authority at
 * runtime; these constants exist so the two sides can be diffed, and are
 * asserted equal in `test/geo.test.ts`.
 */
export const GRID = {
  width: 2810,
  height: 2298,
  resolution: 30,
  minX: -34800,
  // Remember +Z is south: this is the *northern* edge, and it has to reach the
  // Anaga tip at lat 28.61, which lands at z = -35273.
  minZ: -35400,
} as const

/** Bounds of the height grid in local metres (positions of the outermost samples). */
export const ISLAND_BOUNDS = {
  minX: GRID.minX,
  maxX: GRID.minX + (GRID.width - 1) * GRID.resolution,
  minZ: GRID.minZ,
  maxZ: GRID.minZ + (GRID.height - 1) * GRID.resolution,
} as const

/** Width (east-west) of the working area in metres. */
export const ISLAND_WIDTH = ISLAND_BOUNDS.maxX - ISLAND_BOUNDS.minX

/** Depth (north-south) of the working area in metres. */
export const ISLAND_DEPTH = ISLAND_BOUNDS.maxZ - ISLAND_BOUNDS.minZ

/**
 * A point in the island-local frame.
 *
 * Note the axis convention: `x` is eastward and `z` is **southward**, because
 * three.js is right-handed with +Y up, which puts -Z to the north. Northings
 * are therefore negated when converting, and it is easy to get this backwards —
 * the reference-point assertions in `test/geo.test.ts` exist to catch it.
 */
export interface LocalPoint {
  /** Metres east of the origin. */
  x: number
  /** Metres south of the origin. */
  z: number
}

/** Convert geographic coordinates to island-local metres. */
export function lonLatToLocal(lonLat: LonLat): LocalPoint {
  const { east, north } = lonLatToUtm28n(lonLat)
  return { x: east - ORIGIN_EAST, z: -(north - ORIGIN_NORTH) }
}

/** Convert island-local metres back to geographic coordinates. */
export function localToLonLat({ x, z }: LocalPoint): LonLat {
  return utm28nToLonLat({ east: x + ORIGIN_EAST, north: ORIGIN_NORTH - z })
}
