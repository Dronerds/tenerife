/**
 * Centripetal Catmull-Rom, ported from three.js's `CatmullRomCurve3`.
 *
 * Cesium ships `CatmullRomSpline`, and feeding it centripetal knot times looked
 * like it should reproduce the three.js curve. It does not. Cesium builds each
 * cubic on the interval [times[i], times[i+1]], so the knot spacing changes the
 * curve's shape; three.js uses the centripetal spacing only to *estimate the
 * tangents*, then rescales them onto a unit interval per segment. Measured
 * against the three.js path, the Cesium version deviated by up to 167 m
 * horizontally and 177 m vertically over the 68 km route — different valleys at
 * the tight turns, which defeats the point of flying the same route on both
 * branches.
 *
 * So this is three.js's algorithm, transcribed for Cartesian3. Deviation from
 * the three.js path is now sub-centimetre; test/route.test.ts pins it.
 */

import { Cartesian3 } from 'cesium'

/**
 * Coefficients of p(s) = c0 + c1 s + c2 s² + c3 s³ on s ∈ [0,1], with tangents
 * estimated from the non-uniform knot spacing dt0/dt1/dt2 and then rescaled to
 * the unit interval.
 */
function cubic(
  x0: number,
  x1: number,
  x2: number,
  x3: number,
  dt0: number,
  dt1: number,
  dt2: number,
): [number, number, number, number] {
  let t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1
  let t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2
  t1 *= dt1
  t2 *= dt1
  return [x1, t1, -3 * x1 + 3 * x2 - 2 * t1 - t2, 2 * x1 - 2 * x2 + t1 + t2]
}

function evalCubic(c: [number, number, number, number], s: number): number {
  return c[0] + c[1] * s + c[2] * s * s + c[3] * s * s * s
}

/** Endpoint control points are extrapolated, as three.js does, not clamped. */
function extrapolate(a: Cartesian3, b: Cartesian3): Cartesian3 {
  return Cartesian3.subtract(Cartesian3.multiplyByScalar(a, 2, new Cartesian3()), b, new Cartesian3())
}

export class CentripetalSpline {
  constructor(private readonly points: Cartesian3[]) {
    if (points.length < 2) throw new Error('a spline needs at least two points')
  }

  /** Position at `t` in [0,1], distributed evenly across segments as three.js does. */
  evaluate(t: number, out = new Cartesian3()): Cartesian3 {
    const pts = this.points
    const last = pts.length - 1
    const p = last * Math.max(0, Math.min(1, t))
    let index = Math.floor(p)
    let weight = p - index
    if (weight === 0 && index === last) {
      index = last - 1
      weight = 1
    }

    const p1 = pts[index]!
    const p2 = pts[index + 1]!
    const p0 = index > 0 ? pts[index - 1]! : extrapolate(pts[0]!, pts[1]!)
    const p3 = index + 2 <= last ? pts[index + 2]! : extrapolate(pts[last]!, pts[last - 1]!)

    // Centripetal: the exponent is 0.25 over squared distance, i.e. sqrt of distance.
    let dt0 = Math.pow(Cartesian3.distanceSquared(p0, p1), 0.25)
    let dt1 = Math.pow(Cartesian3.distanceSquared(p1, p2), 0.25)
    let dt2 = Math.pow(Cartesian3.distanceSquared(p2, p3), 0.25)
    // Repeated points would divide by zero.
    if (dt1 < 1e-4) dt1 = 1
    if (dt0 < 1e-4) dt0 = dt1
    if (dt2 < 1e-4) dt2 = dt1

    out.x = evalCubic(cubic(p0.x, p1.x, p2.x, p3.x, dt0, dt1, dt2), weight)
    out.y = evalCubic(cubic(p0.y, p1.y, p2.y, p3.y, dt0, dt1, dt2), weight)
    out.z = evalCubic(cubic(p0.z, p1.z, p2.z, p3.z, dt0, dt1, dt2), weight)
    return out
  }
}
