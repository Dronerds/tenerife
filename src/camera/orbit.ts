/**
 * Slow orbit around a fixed point, always looking at it.
 *
 * Replaces the route flight: instead of travelling the island, the camera holds
 * one subject and circles it, which is what you want for looking at a place
 * rather than covering ground.
 */

import { Cartesian3, Cartographic, Ellipsoid, Math as CesiumMath, type Camera } from 'cesium'

export interface OrbitOptions {
  lon: number
  lat: number
  /** Height of the target above the ellipsoid, metres. */
  targetHeight: number
  /** Horizontal distance from the target, metres. */
  radius: number
  /** Camera height above the target, metres. */
  height: number
  /** Compass bearing of the camera from the target at t=0, degrees. */
  startBearing: number
}

/** Degrees per second. A full circuit takes 360/this seconds. */
const DEFAULT_SPEED = 2

export class OrbitCamera {
  speed = DEFAULT_SPEED
  paused = false

  private bearing: number
  private readonly target: Cartesian3
  private readonly east = new Cartesian3()
  private readonly north = new Cartesian3()
  private readonly up = new Cartesian3()
  private readonly eye = new Cartesian3()
  private readonly direction = new Cartesian3()
  private readonly scratch = new Cartesian3()

  constructor(private readonly options: OrbitOptions) {
    this.bearing = options.startBearing
    this.target = Cartesian3.fromDegrees(options.lon, options.lat, options.targetHeight)
    // Local east/north at the target, so the orbit is a real compass circle
    // rather than a circle in some arbitrary plane.
    Ellipsoid.WGS84.geodeticSurfaceNormal(this.target, this.up)
    Cartesian3.normalize(
      Cartesian3.cross(Cartesian3.UNIT_Z, this.target, this.east),
      this.east,
    )
    Cartesian3.cross(this.up, this.east, this.north)
  }

  /** Advance the orbit and drive the camera. `dt` in seconds. */
  update(dt: number, camera: Camera): { bearing: number; paused: boolean } {
    if (!this.paused) this.bearing = (this.bearing + this.speed * dt) % 360

    const a = CesiumMath.toRadians(this.bearing)
    const { radius, height } = this.options
    Cartesian3.clone(this.target, this.eye)
    Cartesian3.add(
      this.eye,
      Cartesian3.multiplyByScalar(this.north, Math.cos(a) * radius, this.scratch),
      this.eye,
    )
    Cartesian3.add(
      this.eye,
      Cartesian3.multiplyByScalar(this.east, Math.sin(a) * radius, this.scratch),
      this.eye,
    )
    Cartesian3.add(
      this.eye,
      Cartesian3.multiplyByScalar(this.up, height, this.scratch),
      this.eye,
    )

    Cartesian3.normalize(
      Cartesian3.subtract(this.target, this.eye, this.direction),
      this.direction,
    )
    // Up is the geodetic normal at the camera, orthogonalised against the view
    // direction — it is not perpendicular to a downward-tilted view.
    const up = Ellipsoid.WGS84.geodeticSurfaceNormal(this.eye, new Cartesian3())
    Cartesian3.subtract(
      up,
      Cartesian3.multiplyByScalar(
        this.direction,
        Cartesian3.dot(up, this.direction),
        this.scratch,
      ),
      up,
    )
    Cartesian3.normalize(up, up)

    camera.setView({ destination: this.eye, orientation: { direction: this.direction, up } })
    return { bearing: this.bearing, paused: this.paused }
  }

  /** Camera altitude above the ellipsoid, for the HUD. */
  get altitude(): number {
    return Cartographic.fromCartesian(this.eye).height
  }
}
