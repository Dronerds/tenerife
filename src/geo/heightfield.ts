/**
 * The resident heightfield.
 *
 * The whole island at 30 m is ~2808 x 2292 = 6.4 M samples. As Float32 that is
 * ~26 MB, which is small enough that it is simply **loaded once and kept
 * forever** — both as a JS `Float32Array` (for CPU queries: drone collision,
 * scatter placement, road conforming) and as a GPU texture sampled in the
 * terrain vertex shader.
 *
 * That single decision removes the entire height-streaming subsystem: there is
 * no tile cache, no async fetch during flight, no LOD seam caused by a missing
 * neighbour, and no pop-in. Only imagery, vegetation and OSM geometry stream.
 *
 * Float32 rather than Float16: the half-float mantissa is 11 bits, which near
 * Teide's 3715 m quantises to ~2 m steps — clearly visible as terracing on a
 * mountain that is the whole point of the island.
 */

import {
  DataTexture,
  FloatType,
  LinearFilter,
  ClampToEdgeWrapping,
  RedFormat,
  type Texture,
} from 'three'

import { classifyBiome, surfaceDetail, wetness, type BiomeId } from '../procedural/surface.ts'
import { COVER, type LandCover } from './landcover.ts'

/** Sidecar metadata written alongside `heights.bin` by `tools/prepare_heights.py`. */
export interface HeightfieldManifest {
  /** Schema version. Bumped when the binary layout changes. */
  version: number
  /** Samples per row (west to east). */
  width: number
  /** Number of rows (north to south). */
  height: number
  /** Ground sample distance in metres. */
  resolution: number
  /** UTM 28N easting of the local origin these samples are expressed against. */
  originEast: number
  /** UTM 28N northing of the local origin. */
  originNorth: number
  /** Coverage in island-local metres. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  /** Lowest and highest elevation present, metres. Used for debug shading ramps. */
  minElevation: number
  maxElevation: number
  /** Value written where the source raster had no data; replaced with 0 on load. */
  nodata: number
}

const SUPPORTED_VERSION = 1

export class Heightfield {
  readonly manifest: HeightfieldManifest
  /** Row-major, row 0 = northernmost (minimum local z). Length = width * height. */
  readonly samples: Float32Array

  private texture: Texture | null = null
  /**
   * Observed land cover, attached after construction.
   *
   * Optional so the heightfield can still load on its own, but every biome query
   * degrades to elevation-only guesses without it — which silently disagrees with
   * the shader, since the shader always has the texture. `main.ts` attaches it
   * immediately after loading both.
   */
  private landCover: LandCover | null = null

  constructor(manifest: HeightfieldManifest, samples: Float32Array) {
    if (manifest.version !== SUPPORTED_VERSION) {
      throw new Error(
        `heightfield manifest version ${manifest.version} is not supported ` +
          `(expected ${SUPPORTED_VERSION}) — re-run tools/prepare_heights.py`,
      )
    }
    const expected = manifest.width * manifest.height
    if (samples.length !== expected) {
      throw new Error(
        `heightfield binary has ${samples.length} samples but the manifest ` +
          `declares ${manifest.width}x${manifest.height} = ${expected}`,
      )
    }
    this.manifest = manifest
    this.samples = samples
  }

  /** Fetch the manifest and binary payload and construct a heightfield. */
  static async load(baseUrl: string): Promise<Heightfield> {
    const [manifestRes, binRes] = await Promise.all([
      fetch(`${baseUrl}/heights.json`),
      fetch(`${baseUrl}/heights.bin`),
    ])
    if (!manifestRes.ok) {
      throw new Error(`could not load ${baseUrl}/heights.json (${manifestRes.status})`)
    }
    if (!binRes.ok) {
      throw new Error(`could not load ${baseUrl}/heights.bin (${binRes.status})`)
    }
    const manifest = (await manifestRes.json()) as HeightfieldManifest
    const samples = new Float32Array(await binRes.arrayBuffer())
    return new Heightfield(manifest, samples)
  }

  /** Attach land cover so CPU biome queries match what the shader computes. */
  setLandCover(landCover: LandCover): void {
    this.landCover = landCover
  }

  /** Compacted WorldCover class at a point, or WATER if none is loaded. */
  getCoverAt(x: number, z: number): number {
    return this.landCover?.classAt(x, z, this.manifest.bounds) ?? COVER.WATER
  }

  /** Raw sample at integer grid coordinates, clamped at the edges. */
  sampleAt(col: number, row: number): number {
    const { width, height } = this.manifest
    const c = col < 0 ? 0 : col >= width ? width - 1 : col
    const r = row < 0 ? 0 : row >= height ? height - 1 : row
    return this.samples[r * width + c] ?? 0
  }

  /**
   * Bilinearly interpolated elevation at a point in island-local metres.
   *
   * This is the **bare** FABDEM surface. It deliberately excludes the
   * procedural displacement added in the terrain vertex shader — anything that
   * needs to agree with what is drawn on screen (drone collision above all)
   * must add that displacement on top, using the shared noise contract in
   * `src/procedural/noise.ts`.
   */
  getHeightAt(x: number, z: number): number {
    const { bounds, resolution } = this.manifest
    const fx = (x - bounds.minX) / resolution
    const fz = (z - bounds.minZ) / resolution

    const c0 = Math.floor(fx)
    const r0 = Math.floor(fz)
    const tx = fx - c0
    const tz = fz - r0

    const h00 = this.sampleAt(c0, r0)
    const h10 = this.sampleAt(c0 + 1, r0)
    const h01 = this.sampleAt(c0, r0 + 1)
    const h11 = this.sampleAt(c0 + 1, r0 + 1)

    const top = h00 + (h10 - h00) * tx
    const bottom = h01 + (h11 - h01) * tx
    return top + (bottom - top) * tz
  }

  /**
   * Elevation of the surface as actually *rendered*, including the procedural
   * displacement the terrain vertex shader adds.
   *
   * This — not `getHeightAt` — is what anything colliding with or resting on the
   * ground must use: the drone, and later vegetation and road conforming.
   * `getHeightAt` returns the bare FABDEM surface, which near the camera can sit
   * several metres away from what the player can see.
   *
   * The shader fades detail out with the finest LOD level's morph factor, but
   * that fade is 1 wherever the camera is, so matching the un-faded amplitude
   * here is correct for anything near the drone. See the comment in
   * terrain.vert.glsl for why the fade is structured that way.
   */
  getSurfaceHeightAt(x: number, z: number): number {
    const base = this.getHeightAt(x, z)
    const [, ny, nz] = this.getNormalAt(x, z)
    const slope = 1 - ny
    const biome = classifyBiome(x, z, base, slope, wetness(nz), this.getCoverAt(x, z))
    return base + surfaceDetail(x, z, biome, slope)
  }

  /** Biome at a point, from the same rules the shader uses. */
  getBiomeAt(x: number, z: number): BiomeId {
    const base = this.getHeightAt(x, z)
    const [, ny, nz] = this.getNormalAt(x, z)
    return classifyBiome(x, z, base, 1 - ny, wetness(nz), this.getCoverAt(x, z))
  }

  /**
   * Surface normal of the bare heightfield, via central differences.
   * Used for slope-conditioned biome and scatter decisions on the CPU.
   */
  getNormalAt(x: number, z: number, epsilon = this.manifest.resolution): [number, number, number] {
    const dx = this.getHeightAt(x + epsilon, z) - this.getHeightAt(x - epsilon, z)
    const dz = this.getHeightAt(x, z + epsilon) - this.getHeightAt(x, z - epsilon)
    const nx = -dx
    const ny = 2 * epsilon
    const nz = -dz
    const len = Math.hypot(nx, ny, nz)
    return [nx / len, ny / len, nz / len]
  }

  /**
   * Slope in radians at a point — 0 is flat, PI/2 is a vertical wall.
   * Note this is slope of the 30 m surface, so it under-reports cliffs that are
   * steep at a finer scale than the DEM can express.
   */
  getSlopeAt(x: number, z: number): number {
    const [, ny] = this.getNormalAt(x, z)
    return Math.acos(Math.min(1, Math.max(-1, ny)))
  }

  /**
   * Compass aspect in radians (0 = north, increasing clockwise) — which way the
   * slope faces. Tenerife's vegetation banding is strongly aspect-dependent:
   * the wet, laurisilva-bearing slopes are the north-facing ones.
   */
  getAspectAt(x: number, z: number): number {
    const [nx, , nz] = this.getNormalAt(x, z)
    // -Z is north in the local frame.
    const angle = Math.atan2(nx, -nz)
    return angle < 0 ? angle + Math.PI * 2 : angle
  }

  /**
   * Single-channel float texture of the whole island for vertex-shader
   * sampling. Created lazily and cached; the GPU copy lives for the session.
   */
  getTexture(): Texture {
    if (this.texture) return this.texture
    const { width, height } = this.manifest
    const tex = new DataTexture(this.samples, width, height, RedFormat, FloatType)
    // Bilinear filtering of a float texture needs OES_texture_float_linear,
    // which is core in WebGL2 for R32F on essentially all desktop GPUs.
    tex.magFilter = LinearFilter
    tex.minFilter = LinearFilter
    tex.wrapS = ClampToEdgeWrapping
    tex.wrapT = ClampToEdgeWrapping
    tex.generateMipmaps = false
    tex.flipY = false
    tex.needsUpdate = true
    this.texture = tex
    return tex
  }

  dispose(): void {
    this.texture?.dispose()
    this.texture = null
  }
}
