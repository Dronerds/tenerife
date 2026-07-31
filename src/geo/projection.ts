/**
 * WGS84 <-> UTM zone 28N (EPSG:32628) — the zone containing Tenerife.
 *
 * Snyder's Transverse Mercator series. Sub-millimetre within a few degrees of
 * the central meridian, and Tenerife sits only ~1.6 deg off it, so this is far
 * more accurate than anything downstream of it needs.
 *
 * This must agree with the Python prep pipeline in `tools/`, which reprojects
 * the source rasters to the same EPSG code via GDAL. `test/projection.test.ts`
 * pins a handful of reference points to guard against drift.
 */

/** Semi-major axis of the WGS84 ellipsoid, metres. */
const A = 6378137.0
/** Flattening. */
const F = 1 / 298.257223563
/** First eccentricity squared. */
const E2 = F * (2 - F)
/** Second eccentricity squared. */
const EP2 = E2 / (1 - E2)
/** UTM scale factor at the central meridian. */
const K0 = 0.9996
/** UTM false easting, metres. */
const FALSE_EASTING = 500000
/** Central meridian of zone 28, degrees. */
const CENTRAL_MERIDIAN_DEG = -15

const DEG = Math.PI / 180

export interface LonLat {
  /** Degrees east, negative for west. */
  lon: number
  /** Degrees north. */
  lat: number
}

export interface Utm {
  /** Easting, metres. */
  east: number
  /** Northing, metres. */
  north: number
}

/** Meridional arc length from the equator to `lat` (radians). */
function meridianArc(lat: number): number {
  return (
    A *
    ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * lat -
      ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * lat) +
      ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * lat) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * lat))
  )
}

/** Project geographic coordinates to UTM zone 28N. */
export function lonLatToUtm28n({ lon, lat }: LonLat): Utm {
  const phi = lat * DEG
  const sinPhi = Math.sin(phi)
  const cosPhi = Math.cos(phi)
  const tanPhi = Math.tan(phi)

  const n = A / Math.sqrt(1 - E2 * sinPhi * sinPhi)
  const t = tanPhi * tanPhi
  const c = EP2 * cosPhi * cosPhi
  const a = (lon - CENTRAL_MERIDIAN_DEG) * DEG * cosPhi
  const m = meridianArc(phi)

  const east =
    K0 *
      n *
      (a +
        ((1 - t + c) * a ** 3) / 6 +
        ((5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5) / 120) +
    FALSE_EASTING

  const north =
    K0 *
    (m +
      n *
        tanPhi *
        ((a * a) / 2 +
          ((5 - t + 9 * c + 4 * c * c) * a ** 4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6) / 720))

  return { east, north }
}

/** Unproject UTM zone 28N back to geographic coordinates. */
export function utm28nToLonLat({ east, north }: Utm): LonLat {
  const x = east - FALSE_EASTING
  const y = north

  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2))
  const mu = y / (K0 * A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256))

  // Footpoint latitude: the latitude whose meridian arc equals `mu`.
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu)

  const sinPhi1 = Math.sin(phi1)
  const cosPhi1 = Math.cos(phi1)
  const tanPhi1 = Math.tan(phi1)

  const c1 = EP2 * cosPhi1 * cosPhi1
  const t1 = tanPhi1 * tanPhi1
  const n1 = A / Math.sqrt(1 - E2 * sinPhi1 * sinPhi1)
  const r1 = (A * (1 - E2)) / (1 - E2 * sinPhi1 * sinPhi1) ** 1.5
  const d = x / (n1 * K0)

  const lat =
    phi1 -
    ((n1 * tanPhi1) / r1) *
      ((d * d) / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6) / 720)

  const lon =
    CENTRAL_MERIDIAN_DEG +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5) / 120) /
      cosPhi1 /
      DEG

  return { lon, lat: lat / DEG }
}
