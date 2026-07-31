/**
 * Real 3D tree geometry, built from foliage cards.
 *
 * This replaces the crossed-billboard crowns for the large trees, and the reason
 * is structural rather than cosmetic: two crossed quads have no volume. From a
 * distance that does not matter, because what identifies a tree is its outline.
 * From 50 m it is the only thing you see, and the result reads as a flat rounded
 * blob no matter how good the silhouette texture is. The palm made this obvious —
 * it stopped looking like a cartoon the moment it got real geometry.
 *
 * The approach is the standard one: a tapered trunk, plus a set of small textured
 * *foliage cards* distributed through the crown volume in three dimensions, each
 * carrying a leaf-clump texture rather than a whole-tree silhouette. Overlapping
 * clumps at different depths give parallax and self-occlusion, which is what
 * actually reads as a canopy.
 *
 * Cost is roughly 60-90 triangles per tree against 6 for a billboard. At the
 * densities here that is a few hundred thousand triangles — affordable, and by
 * far the best value per triangle in the project.
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

export type TreeKind = 'pine' | 'laurel'

const TILE = 128

/** Smooth value noise for ragged clump edges. */
function wobble(x: number, y: number, freq: number, seed: number): number {
  const fx = x * freq
  const fy = y * freq
  const ix = Math.floor(fx)
  const iy = Math.floor(fy)
  const tx = fx - ix
  const ty = fy - iy
  const s = (a: number) => a * a * (3 - 2 * a)
  const a = hashToUnit(hash(ix + seed, iy))
  const b = hashToUnit(hash(ix + 1 + seed, iy))
  const c = hashToUnit(hash(ix + seed, iy + 1))
  const d = hashToUnit(hash(ix + 1 + seed, iy + 1))
  const top = a + (b - a) * s(tx)
  const bottom = c + (d - c) * s(tx)
  return top + (bottom - top) * s(ty)
}

/**
 * Atlas: foliage clump in u = [0, 0.5), bark in u = [0.5, 1].
 *
 * The clump is a *piece* of canopy, not a tree. That distinction is the whole
 * point — a card carrying a tree-shaped silhouette makes a tree of trees, which
 * looks worse than a billboard, whereas a card carrying a branch of leaves
 * assembles into a canopy.
 */
export function createTreeTexture(kind: TreeKind): Texture {
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
        // Canary pine bark is thick, deeply fissured and reddish; laurel is
        // smoother and greyer.
        const fissure =
          kind === 'pine'
            ? Math.abs(((u * 5 + wobble(u, v, 4, 3) * 0.6) % 1) - 0.5)
            : Math.abs(((u * 9 + wobble(u, v, 7, 3) * 0.3) % 1) - 0.5)
        let value = 0.7 + 0.3 * wobble(u, v, 24, 7)
        if (fissure < (kind === 'pine' ? 0.16 : 0.09)) value *= 0.58
        const c = Math.round(Math.min(1, value) * 255)
        data[i] = c
        data[i + 1] = c
        data[i + 2] = c
        data[i + 3] = 255
        continue
      }

      let covered: boolean
      let shade = 0.78 + 0.22 * wobble(u, v, 18, 11)

      if (kind === 'pine') {
        // A spray of long needles from a stem along the card's base edge. Canary
        // pine needles are very long and hang, so the spray droops.
        const stemV = 0.82
        const along = u
        const drop = (v - stemV) * -1
        if (drop < 0) {
          covered = false
        } else {
          // Needles fan out and hang down, thinning at the tips.
          const spread = 0.12 + drop * 1.2
          const centre = 0.5 + (along - 0.5) * 0.4
          const dist = Math.abs(along - centre)
          // Needle frequency must stay low. At 90 cycles across a card the
          // needles are far below a pixel by the time the card is a few metres
          // away, and the alpha test turns that into black speckle and moire
          // rather than into fine detail.
          const needle = Math.abs(Math.sin(along * 15 + drop * 3))
          covered = dist < spread && needle > 0.2 && drop < 0.74 + 0.2 * wobble(u, 0, 5, 5)
          shade *= 0.88 + 0.12 * (1 - drop)
        }
      } else {
        // A clump of broad laurel leaves on a short twig — an ellipse of
        // overlapping leaf shapes with clear gaps at its edge.
        const nx = (u - 0.5) / 0.5
        const ny = (v - 0.45) / 0.5
        const r = Math.sqrt(nx * nx + ny * ny)
        const edge = 0.82 + 0.3 * wobble(u, v, 5, 17)
        if (r > edge) covered = false
        else {
          // Internal structure from a coarse lobe pattern, kept low-frequency for
          // the same reason as the pine needles: fine detail against a hard alpha
          // test becomes speckle, not leaves.
          const leafU = (u * 3.5 + v * 1.2) % 1
          const leafV = (v * 4) % 1
          const lobe = Math.abs(leafU - 0.5) * 1.3 + Math.abs(leafV - 0.5) * 0.7
          covered = lobe < 0.62 || r < 0.55
          shade *= 0.88 + 0.12 * (1 - r)
        }
      }

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

interface Builder {
  positions: number[]
  normals: number[]
  uvs: number[]
}

const FROND_U0 = 0.002
const FROND_U1 = 0.498
const BARK_U0 = 0.502
const BARK_U1 = 0.998

/** Tapered prism trunk, with a slight lean so a stand is not a row of posts. */
function addTrunk(
  b: Builder,
  height: number,
  baseRadius: number,
  sides: number,
  lean: number,
): void {
  const rings = 3
  for (let r = 0; r < rings; r++) {
    const v0 = (r / rings) * height
    const v1 = ((r + 1) / rings) * height
    const rad0 = baseRadius * (1 - 0.55 * (v0 / height))
    const rad1 = baseRadius * (1 - 0.55 * (v1 / height))
    const off0 = lean * (v0 / height) ** 2
    const off1 = lean * (v1 / height) ** 2

    for (let s = 0; s < sides; s++) {
      const a0 = (s / sides) * Math.PI * 2
      const a1 = ((s + 1) / sides) * Math.PI * 2
      const c0 = Math.cos(a0)
      const s0 = Math.sin(a0)
      const c1 = Math.cos(a1)
      const s1 = Math.sin(a1)
      b.positions.push(
        off0 + c0 * rad0, v0, s0 * rad0,
        off0 + c1 * rad0, v0, s1 * rad0,
        off1 + c1 * rad1, v1, s1 * rad1,
        off0 + c0 * rad0, v0, s0 * rad0,
        off1 + c1 * rad1, v1, s1 * rad1,
        off1 + c0 * rad1, v1, s0 * rad1,
      )
      for (const n of [
        [c0, 0, s0], [c1, 0, s1], [c1, 0, s1],
        [c0, 0, s0], [c1, 0, s1], [c0, 0, s0],
      ]) b.normals.push(n[0] as number, n[1] as number, n[2] as number)
      const tv0 = (r / rings) * 2.5
      const tv1 = ((r + 1) / rings) * 2.5
      b.uvs.push(
        BARK_U0, tv0, BARK_U1, tv0, BARK_U1, tv1,
        BARK_U0, tv0, BARK_U1, tv1, BARK_U0, tv1,
      )
    }
  }
}

const tmpNormal = new Vector3()

/**
 * One foliage card: a quad placed at `centre`, facing outward from the trunk and
 * tilted by `pitch`, sized `w` x `h`.
 *
 * Normals are biased upward rather than set to the card's true facing. Foliage is
 * lit from the sky through a canopy, and true facing normals leave every card
 * pointing away from the sun in darkness — the same trap the billboard crowns
 * fell into.
 */
function addCard(
  b: Builder,
  cx: number,
  cy: number,
  cz: number,
  yaw: number,
  pitch: number,
  w: number,
  h: number,
): void {
  const cy_ = Math.cos(yaw)
  const sy = Math.sin(yaw)
  // Card's local right axis, horizontal and perpendicular to its outward facing.
  const rx = -sy
  const rz = cy_
  // Card's local up axis, tilted by pitch away from vertical.
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const ux = cy_ * sp
  const uy = cp
  const uz = sy * sp

  const hw = w / 2
  const hh = h / 2
  const p = (sx: number, sv: number): number[] => [
    cx + rx * hw * sx + ux * hh * sv,
    cy + uy * hh * sv,
    cz + rz * hw * sx + uz * hh * sv,
  ]
  const a = p(-1, -1)
  const q = p(1, -1)
  const c = p(1, 1)
  const d = p(-1, 1)
  b.positions.push(...a, ...q, ...c, ...a, ...c, ...d)

  tmpNormal.set(cy_ * 0.3, 1, sy * 0.3).normalize()
  for (let k = 0; k < 6; k++) b.normals.push(tmpNormal.x, tmpNormal.y, tmpNormal.z)
  b.uvs.push(
    FROND_U0, 0, FROND_U1, 0, FROND_U1, 1,
    FROND_U0, 0, FROND_U1, 1, FROND_U0, 1,
  )
}

/**
 * Unit tree geometry: 1 unit tall, centred on its base.
 *
 * Shape is fixed because it must be one geometry to instance; variation comes
 * from per-instance scale, yaw and colour.
 */
export function createTreeGeometry(kind: TreeKind): BufferGeometry {
  const b: Builder = { positions: [], normals: [], uvs: [] }

  if (kind === 'pine') {
    // Canary pine: a long bare trunk carrying a few well-separated tiers of
    // drooping branches. The gaps between tiers are characteristic — a solid
    // cone is a spruce, and puts the wrong forest on a subtropical island.
    addTrunk(b, 0.98, 0.032, 5, 0.02)
    const tiers = 4
    for (let t = 0; t < tiers; t++) {
      const f = t / (tiers - 1)
      // Tiers occupy the upper 50% of the tree.
      const y = 0.5 + f * 0.45
      // Widest low in the crown, tapering to the leader.
      const radius = 0.26 * (1 - f * 0.7) + 0.03
      const cards = t === tiers - 1 ? 3 : 5
      for (let c = 0; c < cards; c++) {
        const yaw =
          (c / cards) * Math.PI * 2 + hashToUnit(hash(t * 31 + c, 5)) * 0.7
        const jitter = hashToUnit(hash(t * 17 + c, 9))
        addCard(
          b,
          Math.cos(yaw) * radius,
          y + (jitter - 0.5) * 0.06,
          Math.sin(yaw) * radius,
          yaw,
          // Angled well down from vertical, but not flat: at near-horizontal the
          // sprays of adjacent trees merge into one continuous green carpet with
          // no individual crowns visible at all.
          0.82 + jitter * 0.25,
          0.2 + jitter * 0.07,
          0.19 + jitter * 0.06,
        )
      }
    }
  } else {
    // Laurel: short trunk, then a dense near-spherical crown of overlapping leaf
    // clumps distributed through the volume — not just on its surface, or the
    // canopy looks hollow when you fly past its edge.
    addTrunk(b, 0.42, 0.045, 5, 0.03)
    const shells = [
      { y: 0.52, r: 0.24, n: 6, size: 0.4 },
      { y: 0.66, r: 0.34, n: 8, size: 0.42 },
      { y: 0.8, r: 0.28, n: 7, size: 0.38 },
      { y: 0.92, r: 0.15, n: 4, size: 0.32 },
      // Interior clumps, so the crown has depth rather than being a shell.
      { y: 0.7, r: 0.1, n: 3, size: 0.36 },
    ]
    let seed = 0
    for (const shell of shells) {
      for (let c = 0; c < shell.n; c++) {
        seed++
        const yaw = (c / shell.n) * Math.PI * 2 + hashToUnit(hash(seed, 23)) * 0.9
        const jitter = hashToUnit(hash(seed, 41))
        const radius = shell.r * (0.75 + 0.45 * jitter)
        addCard(
          b,
          Math.cos(yaw) * radius,
          shell.y + (jitter - 0.5) * 0.1,
          Math.sin(yaw) * radius,
          yaw,
          // Near vertical, tilted a little outward.
          0.25 + jitter * 0.5,
          shell.size * (0.85 + 0.3 * jitter),
          shell.size * (0.85 + 0.3 * jitter),
        )
      }
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(b.positions, 3))
  geometry.setAttribute('normal', new Float32BufferAttribute(b.normals, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(b.uvs, 2))
  return geometry
}
