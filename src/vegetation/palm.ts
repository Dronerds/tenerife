/**
 * Canary Island date palm — *Phoenix canariensis*, built as real geometry.
 *
 * This is the one plant here that cannot be a billboard, and it is worth being
 * explicit about why rather than treating it as an exception.
 *
 * Every other species is a crossed pair of textured quads, which works because
 * what identifies them is a *silhouette* — a pine's tiered outline, a laurel's
 * rounded mass. A palm's identity is different: a bare, slightly curved trunk
 * carrying a hemispherical crown of long arching pinnate fronds that radiate
 * outwards in three dimensions. Flatten that onto two planes and you get a
 * cartoon, because the thing you recognise is precisely the 3D arrangement the
 * billboard discards.
 *
 * The cost is modest: ~24 triangles of trunk plus 14 fronds at 4 triangles each,
 * so under 90 per palm. Palms are also relatively sparse — street trees, coastal
 * strip, barrancos — so this buys the most recognisable tree on the island for a
 * few hundred thousand triangles at worst.
 *
 * Trunk and fronds share one texture atlas (bark on one half, frond on the other)
 * so a palm is still a single instanced draw call.
 */

import {
  BufferGeometry,
  DataTexture,
  Float32BufferAttribute,
  LinearFilter,
  RGBAFormat,
  Vector3,
  type Texture,
} from 'three'

import { hash, hashToUnit } from '../procedural/noise.ts'

/** Fronds in the crown. Real mature palms carry 30-50; 14 reads correctly. */
const FRONDS = 14
/** Segments per frond, which is what lets it arch rather than stick out flat. */
const FROND_SEGMENTS = 4
/** Trunk height as a fraction of total height. */
const TRUNK_FRACTION = 0.66
/** Trunk cross-section sides. */
const TRUNK_SIDES = 5

const TILE = 128

/**
 * Atlas: frond in u = [0, 0.5), bark in u = [0.5, 1].
 *
 * The frond is *pinnate* — a central rachis with many narrow leaflets angled off
 * it. That comb-like edge is a large part of what makes a palm read as a palm, and
 * it is cheap to draw in a texture where it would be absurd in geometry.
 */
export function createPalmTexture(): Texture {
  const width = TILE * 2
  const data = new Uint8Array(width * TILE * 4)

  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < width; x++) {
      const isBark = x >= TILE
      const tx = isBark ? x - TILE : x
      const u = (tx + 0.5) / TILE
      const v = (y + 0.5) / TILE
      const i = (y * width + x) * 4

      if (isBark) {
        // Phoenix canariensis trunks are covered in the stubs of shed fronds, in
        // a diamond lattice. Coarse and fibrous, never smooth.
        const diamond =
          Math.abs(((u * 7) % 1) - 0.5) + Math.abs(((v * 22) % 1) - 0.5)
        let value = 0.62 + 0.3 * hashToUnit(hash(tx, y))
        if (diamond < 0.34) value *= 0.72
        if (diamond > 0.78) value = Math.min(1, value * 1.2)
        const c = Math.round(Math.min(1, value) * 255)
        data[i] = c
        data[i + 1] = c
        data[i + 2] = c
        data[i + 3] = 255
        continue
      }

      // Frond: v runs from the base of the rachis to the tip, u across its width.
      const along = v
      const across = Math.abs(u - 0.5) * 2

      // The blade narrows towards the tip.
      const halfWidth = (1 - 0.55 * along) * 0.9
      let covered = false

      // The rachis itself: a solid central spine.
      if (across < 0.1 * (1 - 0.5 * along)) covered = true
      else if (across < halfWidth) {
        // Leaflets: narrow strips angled away from the rachis, with gaps between
        // them. The gaps matter — a solid blade reads as a banana leaf, not a palm.
        const leafletPeriod = 34
        const skew = across * 3.2
        const phase = (along * leafletPeriod + skew) % 1
        covered = phase < 0.62
        // Ragged tips: some leaflets are shorter than others.
        const leafletIndex = Math.floor(along * leafletPeriod + skew)
        const reach = 0.72 + 0.28 * hashToUnit(hash(leafletIndex, 5))
        if (across > halfWidth * reach) covered = false
      }

      const shade = 0.82 + 0.18 * hashToUnit(hash(tx >> 1, y >> 1))
      const c = Math.round(Math.min(1, shade) * 255)
      data[i] = c
      data[i + 1] = c
      data[i + 2] = c
      data[i + 3] = covered ? 255 : 0
    }
  }

  const texture = new DataTexture(data, width, TILE, RGBAFormat)
  texture.magFilter = LinearFilter
  texture.minFilter = LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

/**
 * Unit palm geometry: 1 unit tall, centred on its base, ~1 unit crown diameter.
 *
 * Instance transforms scale this to real heights. The shape is fixed rather than
 * randomised per palm because it must be one shared geometry to instance; the
 * variation comes from instance scale, yaw and colour.
 */
export function createPalmGeometry(): BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []

  // Atlas halves, inset slightly so bilinear filtering does not bleed across.
  const e = 0.002
  const frondU0 = e
  const frondU1 = 0.5 - e
  const barkU0 = 0.5 + e
  const barkU1 = 1 - e

  // --- Trunk: a tapered prism with a slight lean, which stops a stand of palms
  // --- looking like a row of identical posts.
  const trunkTop = TRUNK_FRACTION
  const rings = 3
  const lean = 0.045
  for (let r = 0; r < rings; r++) {
    const v0 = (r / rings) * trunkTop
    const v1 = ((r + 1) / rings) * trunkTop
    // Radius tapers upward; real trunks are slightly thicker at the base.
    const rad0 = 0.055 - 0.018 * (v0 / trunkTop)
    const rad1 = 0.055 - 0.018 * (v1 / trunkTop)
    // Lean grows with height, so the trunk curves rather than tilting rigidly.
    const off0 = lean * (v0 / trunkTop) ** 2
    const off1 = lean * (v1 / trunkTop) ** 2

    for (let s = 0; s < TRUNK_SIDES; s++) {
      const a0 = (s / TRUNK_SIDES) * Math.PI * 2
      const a1 = ((s + 1) / TRUNK_SIDES) * Math.PI * 2
      const c0 = Math.cos(a0)
      const s0 = Math.sin(a0)
      const c1 = Math.cos(a1)
      const s1 = Math.sin(a1)

      const p00 = [off0 + c0 * rad0, v0, s0 * rad0]
      const p10 = [off0 + c1 * rad0, v0, s1 * rad0]
      const p01 = [off1 + c0 * rad1, v1, s0 * rad1]
      const p11 = [off1 + c1 * rad1, v1, s1 * rad1]

      positions.push(...p00, ...p10, ...p11, ...p00, ...p11, ...p01)
      for (const n of [
        [c0, 0, s0], [c1, 0, s1], [c1, 0, s1],
        [c0, 0, s0], [c1, 0, s1], [c0, 0, s0],
      ]) {
        normals.push(n[0] as number, n[1] as number, n[2] as number)
      }
      // Bark tiles vertically up the trunk.
      const tv0 = (r / rings) * 3
      const tv1 = ((r + 1) / rings) * 3
      uvs.push(
        barkU0, tv0, barkU1, tv0, barkU1, tv1,
        barkU0, tv0, barkU1, tv1, barkU0, tv1,
      )
    }
  }

  // --- Crown: fronds radiating from the top of the trunk, arching outward and
  // --- then down. The arch is the whole point of segmenting them.
  const crownY = trunkTop
  const crownX = lean
  const tmp = new Vector3()

  for (let f = 0; f < FRONDS; f++) {
    const yaw = (f / FRONDS) * Math.PI * 2 + hashToUnit(hash(f, 13)) * 0.3
    const cy = Math.cos(yaw)
    const sy = Math.sin(yaw)
    // Fronds vary in length and in how steeply they start, so the crown is not a
    // perfect wheel. Outer fronds droop further.
    const length = 0.46 + 0.2 * hashToUnity(f)
    const startPitch = 0.75 - 1.5 * hashToUnity(f + 100)
    const halfWidth = 0.07 + 0.03 * hashToUnity(f + 200)

    for (let seg = 0; seg < FROND_SEGMENTS; seg++) {
      const t0 = seg / FROND_SEGMENTS
      const t1 = (seg + 1) / FROND_SEGMENTS

      // Arch: rises briefly then falls away, accelerating downward at the tip.
      const arc = (t: number): [number, number] => {
        const radial = t * length
        const rise = startPitch * radial - 1.75 * radial * radial
        return [radial, rise]
      }
      const [r0, h0] = arc(t0)
      const [r1, h1] = arc(t1)

      // Blade narrows towards the tip.
      const w0 = halfWidth * (1 - 0.55 * t0)
      const w1 = halfWidth * (1 - 0.55 * t1)

      // Perpendicular to the frond's radial direction, in the horizontal plane.
      const px = -sy
      const pz = cy

      const a = [crownX + cy * r0 - px * w0, crownY + h0, sy * r0 - pz * w0]
      const b = [crownX + cy * r0 + px * w0, crownY + h0, sy * r0 + pz * w0]
      const c = [crownX + cy * r1 + px * w1, crownY + h1, sy * r1 + pz * w1]
      const d = [crownX + cy * r1 - px * w1, crownY + h1, sy * r1 - pz * w1]

      positions.push(...a, ...b, ...c, ...a, ...c, ...d)

      // Normal biased upward: fronds are lit from the sky, and a true face normal
      // would leave every downward-facing frond in darkness. Same reasoning as
      // the billboard normals in instancer.ts.
      tmp.set(cy * 0.25, 1, sy * 0.25).normalize()
      for (let k = 0; k < 6; k++) normals.push(tmp.x, tmp.y, tmp.z)

      uvs.push(
        frondU0, t0, frondU1, t0, frondU1, t1,
        frondU0, t0, frondU1, t1, frondU0, t1,
      )
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
  return geometry
}

/** Deterministic 0..1 helper for the fixed frond variation. */
function hashToUnity(i: number): number {
  return hashToUnit(hash(i, 977))
}
