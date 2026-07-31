/**
 * CDLOD node selection.
 *
 * The island is covered by a square quadtree. Selection descends from the root
 * while the camera is close enough to warrant more detail, so a node is emitted
 * when the camera is further than `DETAIL_FACTOR * nodeSize` away. Because the
 * threshold scales with node size, every emitted node subtends roughly the same
 * angle — which is the whole point: constant screen-space triangle density from
 * 15 m above the ground out to the horizon, at a fixed vertex cost per node.
 *
 * Each emitted node also carries the distance band over which it should morph
 * into its parent's geometry, so the vertex shader can dissolve the transition
 * instead of popping.
 */

import { Box3, Frustum, Matrix4, Vector3 } from 'three'
import type { Camera } from 'three'
import type { Heightfield } from '../geo/heightfield.ts'
import { ISLAND_BOUNDS } from '../geo/origin.ts'

/**
 * Depth of the quadtree below the root. With a ~86 km root this puts leaf nodes
 * at ~168 m across, and with a 64-quad mesh that is ~2.6 m between vertices.
 *
 * One level shallower than the original 10. At a 15 m cruise, 1.3 m vertex
 * spacing was arguably useful; at ~50 m it is well below what the eye can resolve
 * and cost twice the near-field vertices for nothing.
 */
export const MAX_DEPTH = 9

/** Quads per side of a node's mesh. 64 quads = 65x65 = 4225 vertices. */
export const MESH_DIM = 64

/**
 * A node is emitted once the camera is beyond this many node-widths away.
 * Larger = more detail held closer in = more triangles. 2.5 keeps triangles
 * around 8-15 px at 1080p with a 60 degree vertical FOV.
 */
const DETAIL_FACTOR = 2.5

/**
 * Fraction of a node's usable distance band that passes before it starts
 * morphing toward its parent. Morphing too late makes the transition abrupt;
 * too early wastes the finer geometry you already paid for.
 */
const MORPH_START = 0.6

/** Root covers the whole island as a square, so quadrants stay square. */
const ROOT_SIZE = 86016
const ROOT_CENTER_X = (ISLAND_BOUNDS.minX + ISLAND_BOUNDS.maxX) / 2
const ROOT_CENTER_Z = (ISLAND_BOUNDS.minZ + ISLAND_BOUNDS.maxZ) / 2

export interface SelectedNode {
  /** World-space X of the node's minimum corner, metres. */
  x: number
  /** World-space Z of the node's minimum corner, metres. */
  z: number
  /** Edge length, metres. */
  size: number
  /** Depth below the root; MAX_DEPTH is finest. */
  depth: number
  /** Camera distance at which morphing toward the parent begins. */
  morphStart: number
  /** Camera distance at which this node's geometry fully matches its parent. */
  morphEnd: number
}

/**
 * A min/max elevation pyramid over the heightfield.
 *
 * Needed for two things that both go wrong without it: distance-to-node has to
 * account for vertical extent (a camera 3 km above sea level is not "close" to
 * a coastal node just because it is overhead), and frustum culling needs a real
 * bounding box or Teide's flanks get clipped when you look up at them.
 *
 * Level 0 is the full-resolution grid reduced to one entry per leaf-node-sized
 * cell; each higher level halves the resolution.
 */
export class HeightBoundsPyramid {
  private readonly levels: { min: Float32Array; max: Float32Array; cols: number; rows: number }[] =
    []
  /** Node size, in metres, described by one cell of pyramid level 0. */
  private readonly baseCell: number

  constructor(heightfield: Heightfield) {
    const { bounds, resolution } = heightfield.manifest
    this.baseCell = ROOT_SIZE / 2 ** MAX_DEPTH

    const cols = Math.ceil((bounds.maxX - bounds.minX) / this.baseCell) + 1
    const rows = Math.ceil((bounds.maxZ - bounds.minZ) / this.baseCell) + 1
    const min = new Float32Array(cols * rows).fill(Infinity)
    const max = new Float32Array(cols * rows).fill(-Infinity)

    // Reduce every source sample into its leaf cell.
    const { width, height, samples } = { ...heightfield.manifest, samples: heightfield.samples }
    for (let r = 0; r < height; r++) {
      const z = bounds.minZ + r * resolution
      const cellRow = Math.min(rows - 1, Math.floor((z - bounds.minZ) / this.baseCell))
      for (let c = 0; c < width; c++) {
        const x = bounds.minX + c * resolution
        const cellCol = Math.min(cols - 1, Math.floor((x - bounds.minX) / this.baseCell))
        const h = samples[r * width + c] ?? 0
        const i = cellRow * cols + cellCol
        if (h < (min[i] as number)) min[i] = h
        if (h > (max[i] as number)) max[i] = h
      }
    }
    // Cells beyond the data (rounding slack at the edges) are open sea.
    for (let i = 0; i < min.length; i++) {
      if (!Number.isFinite(min[i] as number)) {
        min[i] = 0
        max[i] = 0
      }
    }
    this.levels.push({ min, max, cols, rows })

    // Successive halvings, each cell combining the four below it.
    let prev = this.levels[0]!
    while (prev.cols > 1 || prev.rows > 1) {
      const c2 = Math.max(1, Math.ceil(prev.cols / 2))
      const r2 = Math.max(1, Math.ceil(prev.rows / 2))
      const mn = new Float32Array(c2 * r2).fill(Infinity)
      const mx = new Float32Array(c2 * r2).fill(-Infinity)
      for (let r = 0; r < prev.rows; r++) {
        for (let c = 0; c < prev.cols; c++) {
          const i = (r >> 1) * c2 + (c >> 1)
          const s = r * prev.cols + c
          if ((prev.min[s] as number) < (mn[i] as number)) mn[i] = prev.min[s] as number
          if ((prev.max[s] as number) > (mx[i] as number)) mx[i] = prev.max[s] as number
        }
      }
      this.levels.push({ min: mn, max: mx, cols: c2, rows: r2 })
      prev = this.levels[this.levels.length - 1]!
    }

    this.boundsMinX = bounds.minX
    this.boundsMinZ = bounds.minZ
  }

  private readonly boundsMinX: number
  private readonly boundsMinZ: number

  /** Elevation range overlapping the given square, in metres. */
  query(x: number, z: number, size: number): { min: number; max: number } {
    // Choose the pyramid level whose cells are at least as large as the query,
    // so a handful of lookups covers it.
    const level = Math.min(
      this.levels.length - 1,
      Math.max(0, Math.round(Math.log2(size / this.baseCell))),
    )
    const lv = this.levels[level]!
    const cell = this.baseCell * 2 ** level

    const c0 = Math.floor((x - this.boundsMinX) / cell)
    const c1 = Math.floor((x + size - this.boundsMinX) / cell)
    const r0 = Math.floor((z - this.boundsMinZ) / cell)
    const r1 = Math.floor((z + size - this.boundsMinZ) / cell)

    let min = Infinity
    let max = -Infinity
    for (let r = r0; r <= r1; r++) {
      if (r < 0 || r >= lv.rows) continue
      for (let c = c0; c <= c1; c++) {
        if (c < 0 || c >= lv.cols) continue
        const i = r * lv.cols + c
        if ((lv.min[i] as number) < min) min = lv.min[i] as number
        if ((lv.max[i] as number) > max) max = lv.max[i] as number
      }
    }
    // Entirely outside the data: open ocean.
    if (!Number.isFinite(min)) return { min: 0, max: 0 }
    return { min, max }
  }
}

const tmpBox = new Box3()
const tmpMin = new Vector3()
const tmpMax = new Vector3()
const tmpMatrix = new Matrix4()
const frustum = new Frustum()

/** Shortest distance from a point to an axis-aligned box (0 if inside). */
function distanceToBox(px: number, py: number, pz: number, box: Box3): number {
  const dx = Math.max(box.min.x - px, 0, px - box.max.x)
  const dy = Math.max(box.min.y - py, 0, py - box.max.y)
  const dz = Math.max(box.min.z - pz, 0, pz - box.max.z)
  return Math.hypot(dx, dy, dz)
}

export interface SelectionStats {
  nodes: number
  /** Nodes rejected by the frustum test — useful for sanity-checking culling. */
  culled: number
}

/**
 * Walk the quadtree and collect the nodes to draw this frame.
 *
 * Results are appended to `out`, which the caller reuses across frames to keep
 * this allocation-free on the hot path.
 */
export function selectNodes(
  camera: Camera,
  bounds: HeightBoundsPyramid,
  out: SelectedNode[],
): SelectionStats {
  out.length = 0
  const stats: SelectionStats = { nodes: 0, culled: 0 }

  const eye = camera.getWorldPosition(tmpMin.clone())
  tmpMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  frustum.setFromProjectionMatrix(tmpMatrix)

  const visit = (x: number, z: number, size: number, depth: number): void => {
    const { min, max } = bounds.query(x, z, size)
    tmpBox.set(tmpMin.set(x, min, z), tmpMax.set(x + size, max, z + size))

    if (!frustum.intersectsBox(tmpBox)) {
      stats.culled++
      return
    }

    const dist = distanceToBox(eye.x, eye.y, eye.z, tmpBox)
    const range = DETAIL_FACTOR * size

    if (depth < MAX_DEPTH && dist < range) {
      const half = size / 2
      visit(x, z, half, depth + 1)
      visit(x + half, z, half, depth + 1)
      visit(x, z + half, half, depth + 1)
      visit(x + half, z + half, half, depth + 1)
      return
    }

    // This node is used from `range` out to where its parent takes over, which
    // is exactly twice as far because the threshold scales with node size.
    const end = range * 2
    out.push({
      x,
      z,
      size,
      depth,
      morphStart: range + (end - range) * MORPH_START,
      morphEnd: end,
    })
    stats.nodes++
  }

  visit(ROOT_CENTER_X - ROOT_SIZE / 2, ROOT_CENTER_Z - ROOT_SIZE / 2, ROOT_SIZE, 0)
  return stats
}

export { ROOT_SIZE, ROOT_CENTER_X, ROOT_CENTER_Z }
