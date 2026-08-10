/**
 * The demo flight: Punta Brava to Teide and back.
 *
 * Cruising altitude is ~100 m AGL, up from the 15 m this project started with.
 * Higher is easier, not harder: at 15 m a single 30 m DEM cell filled half the
 * frame, while at 100 m the real terrain data carries most of the image.
 *
 * Chosen because it climbs from sea level to 3715 m and crosses every one of
 * Tenerife's altitudinal vegetation bands in order — coastal euphorbia scrub and
 * banana, the cultivated terraces of the Orotava valley, laurisilva on the wet
 * north slope, Canary pine, then retama broom and bare lava on the plateau.
 *
 * The waypoints below are carried over unchanged from the three.js version, so
 * that both can be flown and compared. Two of their comments refer to layers
 * this branch does not have — the mar de nubes, and the vegetation scatter that
 * set the original cruise altitude. They are left as written because they still
 * explain why each waypoint sits where it does.
 *
 * Altitudes are given either as `agl` (metres above ground, followed as the
 * terrain rises) or `msl` (a fixed height above sea level, for cresting the
 * summit and orbiting it). AGL is the default because the drone is supposed to
 * hug the terrain; MSL is used where hugging would mean flying into a cone.
 */

import { Cartesian3 } from 'cesium'

import { fromLonLatHeight } from '../geo/frame.ts'
import { CentripetalSpline } from './spline.ts'

export interface Waypoint {
  /** Shown in the HUD as the drone passes. */
  name: string
  lon: number
  lat: number
  /** Metres above ground level. Mutually exclusive with `msl`. */
  agl?: number
  /** Metres above sea level. Mutually exclusive with `agl`. */
  msl?: number
}

/**
 * The route, in order.
 *
 * Intermediate points exist mostly to keep the spline on the real valley floors
 * and roads rather than cutting through ridges — a Catmull-Rom curve through
 * only the named landmarks would fly straight into the side of the Orotava
 * valley.
 */
export const ROUTE: Waypoint[] = [
  // --- Coast: Punta Brava and Puerto de la Cruz -----------------------------
  { name: 'Punta Brava', lon: -16.5678, lat: 28.4183, agl: 98 },
  { name: 'Playa Jardín', lon: -16.5588, lat: 28.4192, agl: 99 },
  { name: 'Puerto de la Cruz', lon: -16.5453, lat: 28.4189, agl: 100 },
  { name: 'Puerto harbour', lon: -16.5401, lat: 28.4165, agl: 99 },

  // --- Up the Orotava valley -----------------------------------------------
  { name: 'La Orotava', lon: -16.5236, lat: 28.3903, agl: 101 },
  { name: 'Orotava terraces', lon: -16.5203, lat: 28.3742, agl: 100 },
  { name: 'Aguamansa', lon: -16.5178, lat: 28.3556, agl: 101 },
  { name: 'La Caldera pines', lon: -16.5372, lat: 28.3406, agl: 101 },
  { name: 'Pine forest climb', lon: -16.5533, lat: 28.3208, agl: 102 },

  // --- The plateau ----------------------------------------------------------
  { name: 'El Portillo', lon: -16.5661, lat: 28.3006, agl: 101 },

  // --- Detour east to the observatory --------------------------------------
  { name: 'Izaña approach', lon: -16.5364, lat: 28.3022, agl: 102 },
  { name: 'Teide Observatory', lon: -16.5117, lat: 28.3, agl: 102 },
  { name: 'Back west', lon: -16.5528, lat: 28.2903, agl: 102 },

  // --- Across the caldera floor to the cone --------------------------------
  { name: 'Las Cañadas floor', lon: -16.6011, lat: 28.2617, agl: 101 },
  { name: 'Montaña Blanca', lon: -16.6117, lat: 28.2564, agl: 102 },

  // --- Teide summit, then a circuit of the cone ----------------------------
  // MSL from here: the cone is far too steep to hold a constant AGL, and the
  // orbit needs a level flight path to read as an orbit.
  { name: 'Pico del Teide', lon: -16.6425, lat: 28.2724, msl: 3810 },
  { name: 'Teide — west', lon: -16.6625, lat: 28.2735, msl: 3500 },
  { name: 'Pico Viejo', lon: -16.6712, lat: 28.2647, msl: 3350 },
  { name: 'Teide — south', lon: -16.6478, lat: 28.2561, msl: 3400 },
  { name: 'Teide — east', lon: -16.6255, lat: 28.2668, msl: 3450 },
  { name: 'Teide — north face', lon: -16.6392, lat: 28.2853, msl: 3500 },

  // --- Descend the north slope home ---------------------------------------
  { name: 'North slope descent', lon: -16.6119, lat: 28.3167, agl: 110 },
  // MSL, not AGL: this waypoint only earns its name if it is above the
  // inversion ceiling (DECK_TOP, 1560 m). At an AGL offset it sat at ~1175 m,
  // i.e. inside the deck, and the view was a white wall.
  { name: 'Above the cloud sea', lon: -16.5872, lat: 28.3492, msl: 1780 },
  { name: 'Into the laurisilva', lon: -16.5647, lat: 28.3786, agl: 100 },
  { name: 'Los Realejos', lon: -16.5619, lat: 28.4022, agl: 101 },
  { name: 'Puerto de la Cruz', lon: -16.5453, lat: 28.4189, agl: 100 },
]

/** A waypoint resolved into a route position. */
export interface RoutePoint {
  name: string
  /** x = east metres, y = north metres, z = ellipsoidal height. See geo/frame.ts. */
  position: Cartesian3
  /** Distance along the route to this point, metres. */
  distance: number
}

export class FlightRoute {
  readonly spline: CentripetalSpline
  readonly points: RoutePoint[]
  /** Total route length in metres. */
  readonly length: number

  private readonly cumulative: Float64Array

  /**
   * `groundHeights` is the terrain height under each waypoint, in the same
   * order, used to resolve the `agl` ones. It is a plain array rather than a
   * heightfield because Cesium terrain is sampled asynchronously up front —
   * see terrain-profile.ts — and because it keeps this testable offline.
   */
  constructor(groundHeights: number[], waypoints: Waypoint[] = ROUTE) {
    const positions = waypoints.map((wp, i) => {
      const height = wp.msl !== undefined ? wp.msl : (groundHeights[i] ?? 0) + (wp.agl ?? 20)
      return fromLonLatHeight(wp.lon, wp.lat, height)
    })

    // Centripetal parameterisation, not uniform: with waypoints this unevenly
    // spaced a uniform Catmull-Rom overshoots badly on the tight turns around
    // the cone and would swing the drone out over empty air. See spline.ts for
    // why this is not Cesium's CatmullRomSpline.
    this.spline = new CentripetalSpline(positions)

    // Arc-length table so the drone can fly at a speed in metres per second
    // rather than in curve parameter per second, which would make it crawl
    // between close waypoints and race between distant ones.
    const samples = 4000
    this.cumulative = new Float64Array(samples + 1)
    const a = new Cartesian3()
    const b = new Cartesian3()
    this.spline.evaluate(0, a)
    for (let i = 1; i <= samples; i++) {
      this.spline.evaluate(i / samples, b)
      this.cumulative[i] = this.cumulative[i - 1]! + Cartesian3.distance(a, b)
      Cartesian3.clone(b, a)
    }
    this.length = this.cumulative[samples]!

    // Locate each named waypoint along the arc length.
    //
    // The spline maps control point i to parameter i/(n-1), evenly in
    // *parameter*, but the waypoints are nothing like evenly spaced in
    // *distance* — the hop from Punta Brava to Playa Jardín is under a
    // kilometre while the descent off Teide is fifteen. So the arc length has to
    // be looked up, not assumed: using i/(n-1) * length puts every label and
    // every waypoint jump in the wrong place.
    this.points = waypoints.map((wp, i) => ({
      name: wp.name,
      position: positions[i]!,
      distance: this.distanceAtT(i / (waypoints.length - 1)),
    }))
  }

  /** Arc length from the start of the route to normalised parameter `t`. */
  private distanceAtT(t: number): number {
    const samples = this.cumulative.length - 1
    const f = Math.max(0, Math.min(1, t)) * samples
    const i = Math.min(samples - 1, Math.floor(f))
    const d0 = this.cumulative[i]!
    const d1 = this.cumulative[i + 1]!
    return d0 + (d1 - d0) * (f - i)
  }

  /** Normalised parameter `t` at a given distance along the route. */
  private tAtDistance(distance: number): number {
    const samples = this.cumulative.length - 1
    const target = Math.max(0, Math.min(this.length, distance))
    // Binary search the monotonic arc-length table.
    let lo = 0
    let hi = samples
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.cumulative[mid]! < target) lo = mid + 1
      else hi = mid
    }
    const i = Math.max(1, lo)
    const d0 = this.cumulative[i - 1]!
    const d1 = this.cumulative[i]!
    const frac = d1 > d0 ? (target - d0) / (d1 - d0) : 0
    return (i - 1 + frac) / samples
  }

  /** Position on the route at a distance along it, in metres. */
  positionAt(distance: number, out = new Cartesian3()): Cartesian3 {
    return this.spline.evaluate(this.tAtDistance(distance), out)
  }

  /** Name of the most recently passed waypoint. */
  waypointAt(distance: number): string {
    let name = this.points[0]?.name ?? ''
    for (const p of this.points) {
      if (p.distance <= distance) name = p.name
      else break
    }
    return name
  }
}
