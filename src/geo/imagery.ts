/**
 * Sentinel-2 colour composite, aligned to the island grid.
 *
 * Used for the **mid and far field only**. At 30 m posting this is one pixel per
 * 30 m, which carries no useful information at 15 m AGL — the near field is
 * procedural materials, which have detail the imagery cannot. What imagery
 * supplies is real large-scale colour variation, where procedural biomes
 * otherwise look repetitive and too uniform across a whole hillside.
 *
 * Optional: everything still renders without it, just with procedural colour at
 * all distances. That keeps the heavy data step out of the critical path for
 * anyone cloning the repo.
 */

import { LinearFilter, ClampToEdgeWrapping, TextureLoader, type Texture } from 'three'

export interface ImageryManifest {
  version: number
  width: number
  height: number
  resolution: number
  source: string
  scenes: string[]
}

export class Imagery {
  readonly manifest: ImageryManifest
  readonly texture: Texture

  private constructor(manifest: ImageryManifest, texture: Texture) {
    this.manifest = manifest
    this.texture = texture
  }

  /** Returns null rather than throwing if the imagery has not been generated. */
  static async tryLoad(baseUrl: string): Promise<Imagery | null> {
    let manifest: ImageryManifest
    try {
      const res = await fetch(`${baseUrl}/imagery.json`)
      if (!res.ok) return null
      manifest = (await res.json()) as ImageryManifest
    } catch {
      return null
    }

    const texture = await new TextureLoader().loadAsync(`${baseUrl}/imagery.png`)
    // flipY false to match the heightmap and land cover: row 0 is the north edge.
    texture.flipY = false
    texture.magFilter = LinearFilter
    texture.minFilter = LinearFilter
    texture.wrapS = ClampToEdgeWrapping
    texture.wrapT = ClampToEdgeWrapping
    // Left in the default sRGB colour space: the shader converts to linear
    // itself, alongside the hand-authored biome albedos, so both go through the
    // same conversion and cannot disagree.
    texture.generateMipmaps = true
    texture.needsUpdate = true

    return new Imagery(manifest, texture)
  }

  dispose(): void {
    this.texture.dispose()
  }
}
