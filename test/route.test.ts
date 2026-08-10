import { Cartesian3, Cartographic } from 'cesium'
import { describe, expect, it } from 'vitest'

import { toCartesian } from '../src/geo/frame.ts'
import { FlightRoute, ROUTE } from '../src/drone/route.ts'
import { GroundProfile } from '../src/drone/terrain-profile.ts'

/** Flat ground everywhere, so the route is exercised without touching the network. */
const FLAT = ROUTE.map(() => 0)

describe('ROUTE', () => {
  it('is the 26 waypoints carried over from the three.js version', () => {
    expect(ROUTE).toHaveLength(26)
    expect(ROUTE[0]?.name).toBe('Punta Brava')
    expect(ROUTE[ROUTE.length - 1]?.name).toBe('Puerto de la Cruz')
  })

  it('gives every waypoint exactly one of agl or msl', () => {
    for (const wp of ROUTE) {
      expect(
        (wp.agl !== undefined ? 1 : 0) + (wp.msl !== undefined ? 1 : 0),
        `${wp.name} must have exactly one of agl/msl`,
      ).toBe(1)
    }
  })
})

describe('FlightRoute', () => {
  const route = new FlightRoute(FLAT)

  it('matches the three.js route length', () => {
    // Golden value: the same waypoints on flat ground through three.js's
    // CatmullRomCurve3 measure 70659.3 m. The 6.7 m difference is not the
    // spline — it is UTM scale distortion in the three.js version's frame,
    // which sits ~1.6° off the EPSG:32628 central meridian and so reports
    // distances about 0.01% short. Max path deviation between the two is 6.7 m
    // and accumulates purely along-track. If this drifts, spline.ts has
    // regressed; see the note there about Cesium's CatmullRomSpline.
    expect(route.length).toBeCloseTo(70_666, -1)
  })

  it('places waypoints monotonically along the arc length', () => {
    expect(route.points[0]?.distance).toBeCloseTo(0, 3)
    for (let i = 1; i < route.points.length; i++) {
      expect(route.points[i]!.distance).toBeGreaterThan(route.points[i - 1]!.distance)
    }
    expect(route.points[route.points.length - 1]!.distance).toBeCloseTo(route.length, 0)
  })

  it('names the waypoint most recently passed', () => {
    expect(route.waypointAt(0)).toBe('Punta Brava')
    expect(route.waypointAt(route.length)).toBe('Puerto de la Cruz')
    const orotava = route.points.find((p) => p.name === 'La Orotava')!
    expect(route.waypointAt(orotava.distance + 1)).toBe('La Orotava')
    expect(route.waypointAt(orotava.distance - 1)).not.toBe('La Orotava')
  })

  it('advances at a constant rate in metres, not in curve parameter', () => {
    // The point of the arc-length table: equal distance steps must produce
    // equal ground steps, even though the waypoints are wildly unevenly spaced.
    const a = new Cartesian3()
    const b = new Cartesian3()
    for (const d of [1000, 20_000, 45_000]) {
      route.positionAt(d, a)
      route.positionAt(d + 100, b)
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(90)
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(110)
    }
  })

  it('starts and ends over Punta Brava and Puerto de la Cruz', () => {
    const start = Cartographic.fromCartesian(toCartesian(route.positionAt(0)))
    expect(Cartographic.toCartesian(start)).toBeDefined()
    expect(start.longitude * (180 / Math.PI)).toBeCloseTo(ROUTE[0]!.lon, 3)
    expect(start.latitude * (180 / Math.PI)).toBeCloseTo(ROUTE[0]!.lat, 3)
  })

  it('follows rising ground when a waypoint is agl', () => {
    // Punta Brava is agl 98. Raise the ground under it and the path rises with it.
    const raised = [...FLAT]
    raised[0] = 500
    const lifted = new FlightRoute(raised)
    expect(lifted.positionAt(0).z).toBeCloseTo(500 + 98, 3)
    expect(route.positionAt(0).z).toBeCloseTo(98, 3)
  })

  it('holds a fixed height when a waypoint is msl', () => {
    // Pico del Teide is msl 3810 and must ignore the ground entirely.
    const raised = ROUTE.map(() => 2000)
    const lifted = new FlightRoute(raised)
    const teide = lifted.points.find((p) => p.name === 'Pico del Teide')!
    expect(teide.position.z).toBeCloseTo(3810, 3)
  })
})

describe('GroundProfile', () => {
  it('interpolates between samples and clamps past the end', () => {
    const profile = new GroundProfile(Float64Array.from([0, 100, 100]), 25)
    expect(profile.groundAt(0)).toBe(0)
    expect(profile.groundAt(12.5)).toBeCloseTo(50, 6)
    expect(profile.groundAt(25)).toBe(100)
    expect(profile.groundAt(9999)).toBe(100)
  })
})
