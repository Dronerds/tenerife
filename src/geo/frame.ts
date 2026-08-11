/**
 * A local east-north-up frame over the island, in metres.
 *
 * The flight path is splined here rather than in ECEF. A Catmull-Rom curve
 * through ECEF control points chords straight through the ellipsoid: over the
 * ~15 km leg down Teide's north slope the sagitta is d²/8R ≈ 4.4 m of altitude
 * the drone never asked to lose, which is not noise against a 32 m clearance
 * budget. Banking and heading also assume a fixed up and a flat horizontal
 * plane, which is true locally and false globally.
 *
 * A route position is therefore packed into a Cartesian3 as **x = east metres,
 * y = north metres, z = ellipsoidal height** — note that z is NOT the frame's
 * own up axis. The tangent plane departs from the ellipsoid by d²/2R, about
 * 31 m at the far end of the island, so treating local up as altitude would
 * fly the drone into the sea at the coasts. Height stays a true ellipsoidal
 * height and only the horizontal pair is ever taken from the frame.
 */

import { Cartesian3, Cartographic, Matrix4, Transforms } from 'cesium'

/** Near the island centre, so the tangent-plane error is spread rather than one-sided. */
const ORIGIN = Cartesian3.fromDegrees(-16.6, 28.29, 0)

const TO_FIXED = Transforms.eastNorthUpToFixedFrame(ORIGIN)
const TO_LOCAL = Matrix4.inverseTransformation(TO_FIXED, new Matrix4())

const scratchCartesian = new Cartesian3()
const scratchCartographic = new Cartographic()

/** Geographic position to a route position (east, north, height). */
export function fromLonLatHeight(
  lon: number,
  lat: number,
  height: number,
  out = new Cartesian3(),
): Cartesian3 {
  const fixed = Cartesian3.fromDegrees(lon, lat, 0, undefined, scratchCartesian)
  Matrix4.multiplyByPoint(TO_LOCAL, fixed, out)
  out.z = height
  return out
}

/** Route position (east, north, height) to an ECEF position Cesium can render. */
export function toCartesian(position: Cartesian3, out = new Cartesian3()): Cartesian3 {
  // Resolve the horizontal pair to a geographic position first, then re-apply
  // the height there. Going through the frame's own up axis instead would bend
  // the altitude by the tangent-plane error.
  Cartesian3.fromElements(position.x, position.y, 0, scratchCartesian)
  Matrix4.multiplyByPoint(TO_FIXED, scratchCartesian, scratchCartesian)
  Cartographic.fromCartesian(scratchCartesian, undefined, scratchCartographic)
  return Cartesian3.fromRadians(
    scratchCartographic.longitude,
    scratchCartographic.latitude,
    position.z,
    undefined,
    out,
  )
}
