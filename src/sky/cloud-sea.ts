/**
 * The mar de nubes, as a stack of alpha-blended slabs.
 *
 * See `src/shaders/cloud-sea.frag.glsl` for what the shader does and why. This
 * module is just the geometry and the draw-order bookkeeping, both of which
 * matter more than they look:
 *
 *   - Slabs must be drawn far-to-near for alpha blending to composite correctly,
 *     and which end is "far" flips depending on whether the camera is above or
 *     below the deck. Getting this wrong makes the deck look inside-out from one
 *     side.
 *   - Depth *writing* is off but depth *testing* is on, so terrain occludes cloud
 *     while cloud does not occlude cloud.
 */

import {
  AdditiveBlending,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Camera,
  type Texture,
} from 'three'

import type { Heightfield } from '../geo/heightfield.ts'
import { HAZE_COLOR, HAZE_DENSITY } from './atmosphere.ts'

import noiseGlsl from '../shaders/noise.glsl?raw'
import cloudFrag from '../shaders/cloud-sea.frag.glsl?raw'

/** Base of the trade-wind inversion, metres. */
const DECK_BOTTOM = 780
/** Ceiling of the deck. Above this, Teide stands clear. */
const DECK_TOP = 1560

/**
 * Number of slabs. Enough that flying through feels volumetric rather than like
 * crossing a pane of glass; few enough that the overdraw stays affordable.
 */
const SLABS = 14

/** Horizontal extent of each slab, metres. Covers the island plus its horizon. */
const EXTENT = 150_000

const VERTEX_SHADER = /* glsl */ `
precision highp float;

attribute float aSlabHeight;

varying float vSlabHeight;
varying vec3 vWorldPos;

#include <common>
#include <logdepthbuf_pars_vertex>

void main() {
  // The base plane is unit-sized on XZ; scale it out and lift it to this
  // instance's altitude.
  vec3 world = vec3(position.x, 0.0, position.z) + vec3(0.0, aSlabHeight, 0.0);
  vSlabHeight = aSlabHeight;
  vWorldPos = world;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  #include <logdepthbuf_vertex>
}
`

function composeFragment(): string {
  const marker = 'precision highp sampler2D;'
  const at = cloudFrag.indexOf(marker)
  const cut = at + marker.length
  return `${cloudFrag.slice(0, cut)}\n${noiseGlsl}\n${cloudFrag.slice(cut)}`
}

export class CloudSea {
  readonly group = new Group()

  private readonly material: ShaderMaterial
  private readonly slabHeights: Float32Array
  private readonly attribute: InstancedBufferAttribute
  private readonly cameraPos = new Vector3()
  private elapsed = 0

  constructor(heightfield: Heightfield) {
    const { bounds, resolution, width, height } = heightfield.manifest
    const heightmap: Texture = heightfield.getTexture()

    // A single quad, instanced once per slab.
    const plane = new PlaneGeometry(EXTENT, EXTENT)
    plane.rotateX(-Math.PI / 2)

    const geometry = new InstancedBufferGeometry()
    geometry.index = plane.index
    geometry.attributes = plane.attributes
    geometry.instanceCount = SLABS

    this.slabHeights = new Float32Array(SLABS)
    for (let i = 0; i < SLABS; i++) {
      this.slabHeights[i] = DECK_BOTTOM + ((DECK_TOP - DECK_BOTTOM) * i) / (SLABS - 1)
    }
    this.attribute = new InstancedBufferAttribute(this.slabHeights, 1)
    this.attribute.setUsage(35048 /* DynamicDrawUsage */)
    geometry.setAttribute('aSlabHeight', this.attribute)
    geometry.boundingSphere = null
    geometry.boundingBox = null

    this.material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: composeFragment(),
      transparent: true,
      // Terrain must occlude cloud, but cloud must not occlude cloud — so test
      // depth without writing it.
      depthWrite: false,
      depthTest: true,
      blending: NormalBlending,
      side: DoubleSide,
      uniforms: {
        uHeightmap: { value: heightmap },
        uGridMin: { value: new Vector2(bounds.minX, bounds.minZ) },
        uGridResolution: { value: resolution },
        uGridSizeTexels: { value: new Vector2(width, height) },
        uSunDirection: { value: new Vector3(0.45, 0.72, 0.53).normalize() },
        uCloudColor: { value: new Vector3(1.0, 0.99, 0.97) },
        uCloudShadow: { value: new Vector3(0.52, 0.57, 0.66) },
        uFogColor: { value: new Vector3(HAZE_COLOR.r, HAZE_COLOR.g, HAZE_COLOR.b) },
        uFogDensity: { value: HAZE_DENSITY },
        uDeckBottom: { value: DECK_BOTTOM },
        uDeckTop: { value: DECK_TOP },
        uCoverage: { value: 1 },
        uWind: { value: new Vector2(0, 0) },
      },
    })

    const mesh = new Mesh(geometry, this.material)
    mesh.frustumCulled = false
    // Drawn after the opaque terrain and the sea.
    mesh.renderOrder = 10
    this.group.add(mesh)

    void AdditiveBlending
  }

  /**
   * Advance the wind and re-sort slabs for the current viewpoint.
   *
   * `dt` in seconds. The deck drifts slowly from the north-east, which is the
   * trade-wind direction.
   */
  update(dt: number, camera: Camera): void {
    this.elapsed += dt
    const wind = this.material.uniforms.uWind!.value as Vector2
    wind.set(this.elapsed * 1.6, this.elapsed * -1.1)

    camera.getWorldPosition(this.cameraPos)

    // Re-sort the slab heights so they are drawn back to front. Above the deck
    // that means lowest first; below it, highest first. Without this the
    // blending composites in the wrong order and the deck reads inside-out.
    const descending = this.cameraPos.y > (DECK_BOTTOM + DECK_TOP) * 0.5
    const sorted = Array.from(this.slabHeights).sort((a, b) =>
      descending ? a - b : b - a,
    )
    for (let i = 0; i < sorted.length; i++) this.slabHeights[i] = sorted[i] as number
    this.attribute.needsUpdate = true
  }

  setSunDirection(direction: Vector3): void {
    ;(this.material.uniforms.uSunDirection!.value as Vector3).copy(direction).normalize()
  }

  /** 0 clears the sky, 1 is a full deck. */
  setCoverage(coverage: number): void {
    this.material.uniforms.uCoverage!.value = coverage
  }

  get coverage(): number {
    return this.material.uniforms.uCoverage!.value as number
  }

  dispose(): void {
    this.material.dispose()
  }
}

export { DECK_BOTTOM, DECK_TOP }
