/**
 * FPV camera flying the demo route.
 *
 * Not a flight model — there is no motor mixer, no rate controller and no wind.
 * That belongs to the real simulator. What this does is fly a fixed path in a
 * way that *reads* as a drone: it banks into turns, pitches with the climb,
 * leads the camera slightly ahead of the flight path, and carries enough
 * low-frequency wobble that the motion does not look like a rail.
 *
 * It exists this early because the route is how every later stage gets judged.
 * Vegetation, ground materials and the cloud sea are all things you assess by
 * flying past them at 20 m, not by inspecting a static screenshot.
 */

import { MathUtils, Quaternion, Vector3, type PerspectiveCamera } from 'three'

import type { Heightfield } from '../geo/heightfield.ts'
import { FlightRoute } from './route.ts'

/**
 * Cruise speed, m/s. Roughly 160 km/h — fast for a real drone, but the route is
 * ~65 km and at a plausible 15 m/s it would take over an hour to fly. Adjustable
 * at runtime with `[` and `]`.
 */
const DEFAULT_SPEED = 45

/**
 * Never fly closer than this to the ground, whatever the route asks for.
 *
 * This is the floor that produces an AGL reading of exactly this value: the route
 * asks for ~100 m, but where the spline cuts a corner into rising ground the clamp
 * binds and the drone rides the minimum instead.
 *
 * It has to clear the canopy, not the ground — Canary pine reaches 22 m and
 * laurisilva 14 m — so it cannot go back down near zero.
 */
const MIN_CLEARANCE = 32

/**
 * Metres ahead along the route that the camera aims.
 *
 * Scales with cruise altitude: from higher up the horizon is further away, and a
 * short look-ahead aims the camera steeply down at the ground directly below.
 */
const LOOK_AHEAD = 240

/** Maximum bank angle, radians. */
const MAX_BANK = MathUtils.degToRad(38)

export interface FlightState {
  waypoint: string
  /** Distance travelled along the route, metres. */
  distance: number
  /** Fraction of the route completed, 0..1. */
  progress: number
  speed: number
  /** Metres above ground. */
  agl: number
  altitude: number
  paused: boolean
}

export class DroneFlight {
  readonly route: FlightRoute
  speed = DEFAULT_SPEED
  paused = false
  /** Loop back to the start on completion rather than stopping. */
  loop = true

  private distance = 0
  private bank = 0
  private readonly heightfield: Heightfield

  private readonly pos = new Vector3()
  private readonly ahead = new Vector3()
  private readonly smoothedPos = new Vector3()
  private readonly smoothedAhead = new Vector3()
  private readonly prevForward = new Vector3(0, 0, -1)
  private readonly forward = new Vector3()
  private readonly tmpQuat = new Quaternion()
  private initialised = false

  constructor(heightfield: Heightfield, route?: FlightRoute) {
    this.heightfield = heightfield
    this.route = route ?? new FlightRoute(heightfield)
  }

  /** Distance travelled along the route, metres. */
  get distanceTravelled(): number {
    return this.distance
  }

  /** Jump to a named waypoint, or the nearest one at or before `index`. */
  seekToWaypoint(index: number): void {
    const wp = this.route.points[MathUtils.clamp(index, 0, this.route.points.length - 1)]
    if (wp) {
      this.distance = wp.distance
      this.initialised = false
    }
  }

  seekTo(fraction: number): void {
    this.distance = MathUtils.clamp(fraction, 0, 1) * this.route.length
    this.initialised = false
  }

  /** Advance the flight and drive the camera. `dt` in seconds. */
  update(dt: number, camera: PerspectiveCamera): FlightState {
    if (!this.paused) {
      this.distance += this.speed * dt
      if (this.distance > this.route.length) {
        if (this.loop) this.distance -= this.route.length
        else this.distance = this.route.length
      }
    }

    this.route.positionAt(this.distance, this.pos)
    this.route.positionAt(
      Math.min(this.distance + LOOK_AHEAD, this.route.length),
      this.ahead,
    )

    // Terrain safety. The route's AGL waypoints were resolved against the raw
    // heightfield at authoring time, but the spline cuts corners between them
    // and can dip into a ridge — so clamp every frame, on both the flight point
    // and the aim point (otherwise the camera tilts into the ground on climbs).
    // getSurfaceHeightAt, not getHeightAt: the terrain shader displaces the
    // ground by up to several metres, and clearing the bare FABDEM surface would
    // still fly the drone through visible rock.
    const ground = this.heightfield.getSurfaceHeightAt(this.pos.x, this.pos.z)
    this.pos.y = Math.max(this.pos.y, ground + MIN_CLEARANCE)
    const groundAhead = this.heightfield.getSurfaceHeightAt(this.ahead.x, this.ahead.z)
    this.ahead.y = Math.max(this.ahead.y, groundAhead + MIN_CLEARANCE)

    // Low-pass the position and aim point. The clamp above is a hard step
    // function, and applied raw it makes the camera jolt each time the terrain
    // pushes it up; smoothing turns that into a climb.
    if (!this.initialised) {
      this.smoothedPos.copy(this.pos)
      this.smoothedAhead.copy(this.ahead)
      this.initialised = true
    } else {
      const k = 1 - Math.exp(-dt * 6)
      this.smoothedPos.lerp(this.pos, k)
      this.smoothedAhead.lerp(this.ahead, k)
    }

    // Bank proportional to how fast the heading is turning, which is what makes
    // the motion read as flight rather than as a camera on a spline.
    this.forward.subVectors(this.smoothedAhead, this.smoothedPos).normalize()
    if (dt > 0) {
      const turn = Math.atan2(this.forward.x, this.forward.z) -
        Math.atan2(this.prevForward.x, this.prevForward.z)
      // Unwrap across the +/-PI seam, or a heading passing through south
      // produces a violent full roll.
      const wrapped = Math.atan2(Math.sin(turn), Math.cos(turn))
      const target = MathUtils.clamp(-wrapped / dt * 1.6, -MAX_BANK, MAX_BANK)
      this.bank += (target - this.bank) * (1 - Math.exp(-dt * 3))
    }
    this.prevForward.copy(this.forward)

    camera.position.copy(this.smoothedPos)
    camera.up.set(0, 1, 0)
    camera.lookAt(this.smoothedAhead)
    // Roll about the view axis. Applied after lookAt so it is a true roll and
    // does not disturb the heading or pitch.
    this.tmpQuat.setFromAxisAngle(new Vector3(0, 0, 1), this.bank)
    camera.quaternion.multiply(this.tmpQuat)

    const aglGround = this.heightfield.getSurfaceHeightAt(
      this.smoothedPos.x,
      this.smoothedPos.z,
    )
    return {
      waypoint: this.route.waypointAt(this.distance),
      distance: this.distance,
      progress: this.distance / this.route.length,
      speed: this.speed,
      agl: this.smoothedPos.y - aglGround,
      altitude: this.smoothedPos.y,
      paused: this.paused,
    }
  }
}
