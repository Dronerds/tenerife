/**
 * Sky dome.
 *
 * A large inward-facing sphere locked to the camera. Replaces the flat
 * background colour, which was the most obvious remaining artificiality in every
 * wide shot — a uniform wash behind the island with a hard line where it met the
 * sea.
 *
 * Colours are the maritime subtropical sky over the Canaries: pale, slightly
 * warm near the horizon from sea haze, deepening quickly with altitude.
 */

import { BackSide, Mesh, ShaderMaterial, SphereGeometry, Vector3, type Camera } from 'three'

import skyFrag from '../shaders/sky.frag.glsl?raw'

const VERTEX_SHADER = /* glsl */ `
precision highp float;

varying vec3 vDirection;

void main() {
  // Direction from the dome centre to this vertex, in world space. The dome is
  // centred on the camera, so this is simply the view ray.
  vDirection = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export class SkyDome {
  readonly mesh: Mesh

  private readonly material: ShaderMaterial

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: skyFrag,
      side: BackSide,
      // The dome is always behind everything; it must neither test nor write
      // depth, or it will clip against the far plane at some viewpoints.
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uSunDirection: { value: new Vector3(0.45, 0.72, 0.53).normalize() },
        uZenithColor: { value: new Vector3(0.16, 0.33, 0.62) },
        uHorizonColor: { value: new Vector3(0.72, 0.79, 0.85) },
        uSunColor: { value: new Vector3(1.0, 0.93, 0.80) },
        uCameraHeight: { value: 0 },
      },
    })

    // Radius is arbitrary since depth testing is off; it only has to be large
    // enough that the camera never sits outside it.
    this.mesh = new Mesh(new SphereGeometry(1, 32, 20), this.material)
    this.mesh.frustumCulled = false
    // Drawn first, as a backdrop.
    this.mesh.renderOrder = -1000
    this.mesh.scale.setScalar(1)
  }

  update(camera: Camera): void {
    const position = camera.getWorldPosition(new Vector3())
    // Lock to the camera so the dome is effectively at infinity.
    this.mesh.position.copy(position)
    this.material.uniforms.uCameraHeight!.value = position.y
  }

  setSunDirection(direction: Vector3): void {
    ;(this.material.uniforms.uSunDirection!.value as Vector3).copy(direction).normalize()
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
