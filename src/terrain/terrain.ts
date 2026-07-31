/**
 * The terrain renderer: quadtree selection feeding one instanced draw call.
 *
 * Per frame it walks the quadtree against the camera, writes the resulting
 * nodes into the instance buffers, and updates the shader's camera uniform.
 * There is no loading, no cache and no async work here — the heightmap is
 * resident for the session, so a node can always be drawn the instant it is
 * selected.
 */

import {
  Color,
  DoubleSide,
  Mesh,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  type Camera,
  type Texture,
} from 'three'

import type { Heightfield } from '../geo/heightfield.ts'
import type { LandCover } from '../geo/landcover.ts'
import type { Imagery } from '../geo/imagery.ts'
import { HAZE_COLOR, HAZE_DENSITY } from '../sky/atmosphere.ts'
import { SEA_COLOR } from '../sky/sea.ts'
import { createDetailTexture, DETAIL_TILE_METRES } from '../procedural/detail-texture.ts'
import { createChunkGeometry, type ChunkGeometry } from './chunk-geometry.ts'
import {
  HeightBoundsPyramid,
  MAX_DEPTH,
  MESH_DIM,
  selectNodes,
  type SelectedNode,
} from './quadtree.ts'

import noiseGlsl from '../shaders/noise.glsl?raw'
import surfaceGlsl from '../shaders/surface.glsl?raw'
import terrainVert from '../shaders/terrain.vert.glsl?raw'
import terrainFrag from '../shaders/terrain.frag.glsl?raw'

/**
 * GLSL has no include mechanism of its own, so the shared noise and surface
 * definitions are concatenated in. They are kept as separate files rather than
 * inlined so that the noise-parity check can read exactly the same source the
 * GPU runs, instead of a copy that can silently drift.
 *
 * The `precision` lines must stay at the top of the final source, so the shared
 * chunks are spliced in after them rather than simply prepended.
 */
function compose(shader: string): string {
  const marker = 'precision highp sampler2D;'
  const at = shader.indexOf(marker)
  if (at < 0) throw new Error('shader is missing the precision marker')
  const cut = at + marker.length
  return `${shader.slice(0, cut)}\n${noiseGlsl}\n${surfaceGlsl}\n${shader.slice(cut)}`
}

/**
 * Instance capacity. A full-detail view from ground level selects on the order
 * of a few hundred nodes; 4096 leaves generous headroom while capping the
 * worst case at ~17 M triangles.
 */
const MAX_NODES = 4096

export type DebugMode = 'materials' | 'depth' | 'morph' | 'biome'

const DEBUG_MODES: Record<DebugMode, number> = {
  materials: 0,
  depth: 1,
  morph: 2,
  biome: 3,
}

export const DEBUG_MODE_ORDER: DebugMode[] = ['materials', 'depth', 'morph', 'biome']

export interface TerrainStats {
  /** Nodes drawn this frame. */
  nodes: number
  /** Nodes rejected by the frustum test. */
  culled: number
  /** Triangles submitted this frame. */
  triangles: number
  /** True if selection hit MAX_NODES and nodes were dropped. */
  saturated: boolean
}

export class Terrain {
  readonly mesh: Mesh
  readonly stats: TerrainStats = { nodes: 0, culled: 0, triangles: 0, saturated: false }

  private readonly chunk: ChunkGeometry
  private readonly material: ShaderMaterial
  private readonly bounds: HeightBoundsPyramid
  private readonly selection: SelectedNode[] = []
  private readonly cameraPos = new Vector3()
  private readonly detailMap: Texture

  constructor(heightfield: Heightfield, landCover: LandCover, imagery: Imagery | null) {
    this.detailMap = createDetailTexture()
    this.bounds = new HeightBoundsPyramid(heightfield)
    this.chunk = createChunkGeometry(MESH_DIM, MAX_NODES)

    const { bounds, resolution, width, height } = heightfield.manifest
    const heightmap: Texture = heightfield.getTexture()

    this.material = new ShaderMaterial({
      vertexShader: compose(terrainVert),
      fragmentShader: compose(terrainFrag),
      side: DoubleSide,
      // `lights: true` is required for three to inject the shadow-map uniforms
      // the shader's getShadowMask() depends on. It also means the light uniform
      // block must be merged in, or the shader compiles against undefined
      // uniforms.
      lights: true,
      uniforms: UniformsUtils.merge([
        UniformsLib.lights,
        {
        uHeightmap: { value: heightmap },
        uLandCover: { value: landCover.getTexture() },
        // A 1x1 white fallback keeps the sampler bound when imagery is absent;
        // uImageryBlend is 0 then, so the value is never used.
        uImagery: { value: imagery?.texture ?? heightfield.getTexture() },
        uImageryBlend: { value: imagery ? 1 : 0 },
        uGridMin: { value: new Vector2(bounds.minX, bounds.minZ) },
        uGridResolution: { value: resolution },
        uGridSizeTexels: { value: new Vector2(width, height) },
        uCameraPos: { value: this.cameraPos },
        uMeshDim: { value: MESH_DIM },
        uMaxDepth: { value: MAX_DEPTH },
        uDetailScale: { value: 1 },
        uDetailMap: { value: this.detailMap },
        uDetailTile: { value: DETAIL_TILE_METRES },
        uSunDirection: { value: new Vector3(0.45, 0.72, 0.53).normalize() },
        uSunColor: { value: new Color(1.0, 0.96, 0.88) },
        uSkyColor: { value: new Color(0.26, 0.34, 0.46) },
        uDebugMode: { value: DEBUG_MODES.materials },
        uSeaColor: { value: new Color().copy(SEA_COLOR) },
        uFogColor: { value: new Color().copy(HAZE_COLOR) },
          uFogDensity: { value: HAZE_DENSITY },
        },
      ]),
    })
    // UniformsUtils.merge clones values, so texture and vector references have to
    // be reattached afterwards — otherwise the material holds copies and the
    // per-frame camera updates never reach the GPU.
    this.material.uniforms.uHeightmap!.value = heightmap
    this.material.uniforms.uLandCover!.value = landCover.getTexture()
    this.material.uniforms.uImagery!.value = imagery?.texture ?? heightmap
    this.material.uniforms.uCameraPos!.value = this.cameraPos
    this.material.uniforms.uDetailMap!.value = this.detailMap

    this.mesh = new Mesh(this.chunk.geometry, this.material)
    // Selection and culling are the quadtree's job; three.js has no useful
    // bounds for a mesh whose vertices are placed entirely in the shader.
    this.mesh.frustumCulled = false
  }

  setDebugMode(mode: DebugMode): void {
    this.material.uniforms.uDebugMode!.value = DEBUG_MODES[mode]
  }

  /** 0 uses procedural colour at all distances; 1 blends satellite into the far field. */
  setImageryBlend(blend: number): void {
    this.material.uniforms.uImageryBlend!.value = blend
  }

  /**
   * Scale on procedural surface displacement. 0 disables it, which is the
   * clearest way to see how much of the perceived detail it is responsible for.
   */
  setDetailScale(scale: number): void {
    this.material.uniforms.uDetailScale!.value = scale
  }

  setSunDirection(direction: Vector3): void {
    ;(this.material.uniforms.uSunDirection!.value as Vector3).copy(direction).normalize()
  }

  /** Re-select nodes for the current camera. Call once per frame before render. */
  update(camera: Camera): void {
    camera.getWorldPosition(this.cameraPos)

    const { culled } = selectNodes(camera, this.bounds, this.selection)
    const count = Math.min(this.selection.length, MAX_NODES)

    const { offset, scale, morphRange, depth } = this.chunk.instances
    const offsetArr = offset.array as Float32Array
    const scaleArr = scale.array as Float32Array
    const morphArr = morphRange.array as Float32Array
    const depthArr = depth.array as Float32Array

    for (let i = 0; i < count; i++) {
      const node = this.selection[i]!
      offsetArr[i * 2] = node.x
      offsetArr[i * 2 + 1] = node.z
      scaleArr[i] = node.size
      morphArr[i * 2] = node.morphStart
      morphArr[i * 2 + 1] = node.morphEnd
      depthArr[i] = node.depth
    }

    offset.needsUpdate = true
    scale.needsUpdate = true
    morphRange.needsUpdate = true
    depth.needsUpdate = true
    this.chunk.geometry.instanceCount = count

    this.stats.nodes = count
    this.stats.culled = culled
    this.stats.triangles = count * MESH_DIM * MESH_DIM * 2
    this.stats.saturated = this.selection.length > MAX_NODES
  }

  dispose(): void {
    this.chunk.geometry.dispose()
    this.material.dispose()
    this.detailMap.dispose()
  }
}
