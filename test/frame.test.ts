import { Cartesian3, Cartographic } from 'cesium'
import { describe, expect, it } from 'vitest'

import { fromLonLatHeight, toCartesian } from '../src/geo/frame.ts'

/** The two landmarks the deleted three.js geo test pinned, kept as the same fixtures. */
const TEIDE = { lon: -16.6425, lat: 28.2724 }
const SANTA_CRUZ = { lon: -16.2518, lat: 28.4682 }

describe('local ENU frame', () => {
  it('round-trips geographic positions across the island', () => {
    for (const { lon, lat } of [TEIDE, SANTA_CRUZ]) {
      for (const height of [0, 3715]) {
        const back = Cartographic.fromCartesian(
          toCartesian(fromLonLatHeight(lon, lat, height)),
        )
        // Measured as ground distance, because that is the unit the error means
        // anything in. Sub-metre rather than exact: the horizontal pair is read
        // off a tangent plane sitting up to ~31 m above the ellipsoid at the far
        // end of the island, and re-projecting off that plane shifts the result
        // by roughly that offset times the ~0.2° divergence of the two up
        // vectors. Irrelevant for a camera path, and consistent — the route and
        // the terrain sampling both go through this same mapping.
        const drift = Cartesian3.distance(
          Cartesian3.fromDegrees(lon, lat, 0),
          Cartesian3.fromRadians(back.longitude, back.latitude, 0),
        )
        expect(drift).toBeLessThan(2)
        // Height is carried, not derived from the frame, so it is exact.
        expect(back.height).toBeCloseTo(height, 6)
      }
    }
  })

  it('puts north on +y and east on +x', () => {
    // The axis convention changed from the three.js version's +Z-south frame.
    // A sign flip here is the single most likely regression, so pin it.
    const origin = fromLonLatHeight(-16.6, 28.29, 0)
    const north = fromLonLatHeight(-16.6, 28.34, 0)
    const east = fromLonLatHeight(-16.5, 28.29, 0)

    expect(north.y).toBeGreaterThan(origin.y + 5000)
    expect(Math.abs(north.x - origin.x)).toBeLessThan(1)
    expect(east.x).toBeGreaterThan(origin.x + 9000)
    expect(Math.abs(east.y - origin.y)).toBeLessThan(50)
  })

  it('measures distance in metres', () => {
    // Teide to Santa Cruz is ~42 km. Checked against the ECEF chord, which is
    // the thing the ENU plane is meant to approximate over island distances.
    const a = fromLonLatHeight(TEIDE.lon, TEIDE.lat, 0)
    const b = fromLonLatHeight(SANTA_CRUZ.lon, SANTA_CRUZ.lat, 0)
    const planar = Math.hypot(b.x - a.x, b.y - a.y)
    const chord = Cartesian3.distance(
      Cartesian3.fromDegrees(TEIDE.lon, TEIDE.lat, 0),
      Cartesian3.fromDegrees(SANTA_CRUZ.lon, SANTA_CRUZ.lat, 0),
    )
    expect(planar).toBeGreaterThan(40_000)
    expect(planar).toBeLessThan(45_000)
    expect(planar - chord).toBeLessThan(1)
  })
})
