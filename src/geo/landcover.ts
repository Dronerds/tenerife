/**
 * Observed land cover, resident alongside the heightfield.
 *
 * ESA WorldCover 10 m, resampled to the height grid by
 * `tools/prepare_landcover.py`. One byte per sample, ~6.5 MB — small enough to
 * follow the same rule as the heights and simply stay in memory for the session.
 *
 * This tells us *what is there*; elevation and aspect tell us *which kind*.
 * WorldCover reports "tree cover" without distinguishing laurisilva at 800 m
 * from Canary pine at 1600 m, and that distinction is most of the island's
 * character — so the two are combined in `classifyBiome`, not used in isolation.
 */

import {
  DataTexture,
  NearestFilter,
  ClampToEdgeWrapping,
  RedFormat,
  UnsignedByteType,
  type Texture,
} from 'three'

/** Compacted WorldCover classes. Must match CLASS_REMAP in prepare_landcover.py. */
export const COVER = {
  WATER: 0,
  TREES: 1,
  SHRUB: 2,
  GRASS: 3,
  CROPLAND: 4,
  BUILT: 5,
  BARE: 6,
  SNOW: 7,
  WETLAND: 8,
  MOSS: 9,
} as const

export interface LandCoverManifest {
  version: number
  width: number
  height: number
  resolution: number
  source: string
  classes: Record<string, string>
}

const SUPPORTED_VERSION = 1

export class LandCover {
  readonly manifest: LandCoverManifest
  /** Row-major, row 0 = northernmost. One compacted class id per sample. */
  readonly samples: Uint8Array

  private texture: Texture | null = null

  constructor(manifest: LandCoverManifest, samples: Uint8Array) {
    if (manifest.version !== SUPPORTED_VERSION) {
      throw new Error(
        `landcover manifest version ${manifest.version} is not supported ` +
          `(expected ${SUPPORTED_VERSION}) — re-run tools/prepare_landcover.py`,
      )
    }
    const expected = manifest.width * manifest.height
    if (samples.length !== expected) {
      throw new Error(
        `landcover binary has ${samples.length} samples but the manifest declares ` +
          `${manifest.width}x${manifest.height} = ${expected}`,
      )
    }
    this.manifest = manifest
    this.samples = samples
  }

  static async load(baseUrl: string): Promise<LandCover> {
    const [manifestRes, binRes] = await Promise.all([
      fetch(`${baseUrl}/landcover.json`),
      fetch(`${baseUrl}/landcover.bin`),
    ])
    if (!manifestRes.ok || !binRes.ok) {
      throw new Error(
        `could not load land cover from ${baseUrl} — run tools/prepare_landcover.py`,
      )
    }
    const manifest = (await manifestRes.json()) as LandCoverManifest
    const samples = new Uint8Array(await binRes.arrayBuffer())
    return new LandCover(manifest, samples)
  }

  /**
   * Class at a point in island-local metres.
   *
   * Nearest sample, never interpolated: these are categorical ids, and averaging
   * "tree cover" with "built-up" yields "grassland" — inventing a class that was
   * never observed. The same reasoning applies to the GPU texture's filtering.
   */
  classAt(x: number, z: number, bounds: { minX: number; minZ: number }): number {
    const { width, height, resolution } = this.manifest
    const col = Math.round((x - bounds.minX) / resolution)
    const row = Math.round((z - bounds.minZ) / resolution)
    const c = col < 0 ? 0 : col >= width ? width - 1 : col
    const r = row < 0 ? 0 : row >= height ? height - 1 : row
    return this.samples[r * width + c] ?? COVER.WATER
  }

  /** Single-channel byte texture for shader sampling. Nearest-filtered. */
  getTexture(): Texture {
    if (this.texture) return this.texture
    const { width, height } = this.manifest
    const tex = new DataTexture(
      this.samples,
      width,
      height,
      RedFormat,
      UnsignedByteType,
    )
    // NearestFilter is mandatory, for the reason given on classAt().
    tex.magFilter = NearestFilter
    tex.minFilter = NearestFilter
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
