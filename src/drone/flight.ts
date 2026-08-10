/**
 * FPV camera flying the demo route.
 *
 * Not a flight model — there is no motor mixer, no rate controller and no wind.
 * That belongs to the real simulator. What this does is fly a fixed path in a
 * way that *reads* as a drone: it banks into turns, pitches with the climb,
 * leads the camera slightly ahead of the flight path, and carries enough
 * low-frequency wobble that the motion does not look like a rail.
 *
 * The kinematics are the three.js version's, unchanged, so the two branches fly
 * identically. What differs is the frame and the last step: positions are local
 * ENU (see geo/frame.ts), ground comes from a pre-sampled profile rather than a
 * resident heightfield, and the camera is set from an explicit direction and up
 * vector because Cesium has no `lookAt` that leaves roll alone.
 */

import {
  Cartesian3,
  Ellipsoid,
  Math as CesiumMath,
  Matrix3,
  Quaternion,
  type Camera,
} from 'cesium'

import { toCartesian } from '../geo/frame.ts'
import { FlightRoute } from './route.ts'
import type { GroundProfile } from './terrain-profile.ts'

/**
 * Cruise speed, m/s. Roughly 160 km/h — fast for a real drone, but the route is
 * ~68 km and at a plausible 15 m/s it would take over an hour to fly. Adjustable
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
const MAX_BANK = CesiumMath.toRadians(38)

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
  speed = DEFAULT_SPEED
  paused = false
  /** Loop back to the start on completion rather than stopping. */
  loop = true

  private distance = 0
  private bank = 0

  private readonly pos = new Cartesian3()
  private readonly ahead = new Cartesian3()
  private readonly smoothedPos = new Cartesian3()
  private readonly smoothedAhead = new Cartesian3()
  private prevHeading = 0
  private readonly forward = new Cartesian3()
  private readonly eye = new Cartesian3()
  private readonly target = new Cartesian3()
  private readonly direction = new Cartesian3()
  private readonly up = new Cartesian3()
  private readonly scratch = new Cartesian3()
  private readonly rollQuat = new Quaternion()
  private readonly rollMat = new Matrix3()
  private initialised = false

  constructor(
    readonly route: FlightRoute,
    private readonly ground: GroundProfile,
  ) {}

  /** Distance travelled along the route, metres. */
  get distanceTravelled(): number {
    return this.distance
  }

  /** Jump to a named waypoint, or the nearest one at or before `index`. */
  seekToWaypoint(index: number): void {
    const wp = this.route.points[CesiumMath.clamp(index, 0, this.route.points.length - 1)]
    if (wp) {
      this.distance = wp.distance
      this.initialised = false
    }
  }

  seekTo(fraction: number): void {
    this.distance = CesiumMath.clamp(fraction, 0, 1) * this.route.length
    this.initialised = false
  }

  /** Advance the flight and drive the camera. `dt` in seconds. */
  update(dt: number, camera: Camera): FlightState {
    if (!this.paused) {
      this.distance += this.speed * dt
      if (this.distance > this.route.length) {
        if (this.loop) this.distance -= this.route.length
        else this.distance = this.route.length
      }
    }

    const aheadDistance = Math.min(this.distance + LOOK_AHEAD, this.route.length)
    this.route.positionAt(this.distance, this.pos)
    this.route.positionAt(aheadDistance, this.ahead)

    // Terrain safety. The route's AGL waypoints were resolved against the terrain
    // at each waypoint, but the spline cuts corners between them and can dip into
    // a ridge — so clamp every frame, on both the flight point and the aim point
    // (otherwise the camera tilts into the ground on climbs). Unlike the three.js
    // version this reads the profile by distance travelled rather than by
    // position, which is both cheaper and more correct: the look-ahead clamp now
    // samples where the drone is actually going rather than at its pre-clamp
    // position.
    this.pos.z = Math.max(this.pos.z, this.ground.groundAt(this.distance) + MIN_CLEARANCE)
    this.ahead.z = Math.max(
      this.ahead.z,
      this.ground.groundAt(aheadDistance) + MIN_CLEARANCE,
    )

    // Low-pass the position and aim point. The clamp above is a hard step
    // function, and applied raw it makes the camera jolt each time the terrain
    // pushes it up; smoothing turns that into a climb.
    const seeked = !this.initialised
    if (seeked) {
      Cartesian3.clone(this.pos, this.smoothedPos)
      Cartesian3.clone(this.ahead, this.smoothedAhead)
      this.initialised = true
    } else {
      const k = 1 - Math.exp(-dt * 6)
      Cartesian3.lerp(this.smoothedPos, this.pos, k, this.smoothedPos)
      Cartesian3.lerp(this.smoothedAhead, this.ahead, k, this.smoothedAhead)
    }

    // Bank proportional to how fast the heading is turning, which is what makes
    // the motion read as flight rather than as a camera on a spline.
    Cartesian3.subtract(this.smoothedAhead, this.smoothedPos, this.forward)
    Cartesian3.normalize(this.forward, this.forward)
    // Compass heading in the local frame: +y is north, +x is east.
    const heading = Math.atan2(this.forward.x, this.forward.y)
    // Skip the frame after a seek: the heading delta would be measured against
    // wherever the drone was before the jump, which snaps the camera into a
    // full-scale roll for no reason.
    if (dt > 0 && !seeked) {
      const turn = heading - this.prevHeading
      // Unwrap across the +/-PI seam, or a heading passing through south
      // produces a violent full roll.
      const wrapped = Math.atan2(Math.sin(turn), Math.cos(turn))
      const target = CesiumMath.clamp((wrapped / dt) * 1.6, -MAX_BANK, MAX_BANK)
      this.bank += (target - this.bank) * (1 - Math.exp(-dt * 3))
    }
    this.prevHeading = heading

    toCartesian(this.smoothedPos, this.eye)
    toCartesian(this.smoothedAhead, this.target)
    Cartesian3.normalize(
      Cartesian3.subtract(this.target, this.eye, this.direction),
      this.direction,
    )

    // Up is the geodetic normal, rolled about the view axis by the bank angle,
    // then re-orthogonalised — the normal is not perpendicular to the view
    // direction when the drone is climbing or diving.
    Ellipsoid.WGS84.geodeticSurfaceNormal(this.eye, this.up)
    Quaternion.fromAxisAngle(this.direction, this.bank, this.rollQuat)
    Matrix3.fromQuaternion(this.rollQuat, this.rollMat)
    Matrix3.multiplyByVector(this.rollMat, this.up, this.up)
    Cartesian3.subtract(
      this.up,
      Cartesian3.multiplyByScalar(
        this.direction,
        Cartesian3.dot(this.up, this.direction),
        this.scratch,
      ),
      this.up,
    )
    Cartesian3.normalize(this.up, this.up)

    camera.setView({
      destination: this.eye,
      orientation: { direction: this.direction, up: this.up },
    })

    const ground = this.ground.groundAt(this.distance)
    return {
      waypoint: this.route.waypointAt(this.distance),
      distance: this.distance,
      progress: this.distance / this.route.length,
      speed: this.speed,
      agl: this.smoothedPos.z - ground,
      altitude: this.smoothedPos.z,
      paused: this.paused,
    }
  }
}
