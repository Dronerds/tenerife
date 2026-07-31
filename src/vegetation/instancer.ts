/**
 * Vegetation scatter.
 *
 * Plants are placed in a grid of cells around the camera. Each cell's contents
 * are a pure function of its integer coordinates, so a given plant sits in the
 * same place every session, at every LOD, approached from any direction — the
 * same determinism rule the terrain detail follows, and for the same reason:
 * anything derived from `Math.random()` would visibly reshuffle as you fly.
 *
 * Only cells within a fixed radius are populated. That is a hard cap on cost
 * regardless of where the drone is, and it is why this is affordable at 20 m AGL
 * over dense laurisilva.
 *
 * Rendering is one InstancedMesh per species, with crowns as crossed billboards
 * and trunks as thin boxes. That is deliberately crude: at the altitude the
 * drone flies, silhouette and density carry the impression and leaf-level
 * geometry would be invisible.
 */

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type Camera,
} from 'three'

import type { Heightfield } from '../geo/heightfield.ts'
import { hash, hashToUnit } from '../procedural/noise.ts'
import { BIOME_SPECIES, ALL_SPECIES, type Species } from './species.ts'
import { createFoliageTexture, HABITS, type Habit } from './foliage-texture.ts'
import { createPalmGeometry, createPalmTexture } from './palm.ts'
import { createTreeGeometry, createTreeTexture, type TreeKind } from './tree-geometry.ts'

/** Cell size in metres. Each cell holds a handful of plants. */
const CELL = 40

/**
 * Radius, in cells, populated around the camera. 16 cells = 640 m.
 *
 * Grown alongside the move to ~100 m cruise. Plants stop at this radius, and the
 * higher the camera the further that edge is visible — at 15 m AGL terrain
 * occluded it, at 100 m it does not. Cost grows as the square, which is why this
 * cannot simply be set large: see the instance cap below.
 */
const RADIUS = 16

/**
 * Size of a cultivation plot, metres.
 *
 * Row orientation is shared across a whole plot rather than per cell, so a field
 * reads as one continuous set of rows. Per-cell orientation would shatter every
 * plantation into 40 m squares of mismatched stripes, which is worse than not
 * having rows at all.
 */
const PLOT = 220

/**
 * Hard cap on instances per species.
 *
 * Sized for banana, which at 2.4 m row spacing puts ~170,000 plants per square
 * kilometre — two orders of magnitude denser than anything scattered.
 */
const MAX_PER_SPECIES = 60000

/**
 * Crown geometry: two crossed vertical quads plus a horizontal canopy quad.
 *
 * The horizontal quad is the important addition. Crossed *vertical* billboards
 * are edge-on when viewed from directly above, so from a drone at 50 m a forest
 * of them reads as a field of thin lines with the ground showing through. The
 * horizontal quad is what the drone actually looks at from survey altitude.
 *
 * UVs address a two-tile atlas: the vertical quads take the side-view tile in
 * u = [0, 0.5], the horizontal quad takes the top-view tile in u = [0.5, 1].
 * One texture, one material, one draw call per species.
 */
function crownGeometry(): BufferGeometry {
  const g = new BufferGeometry()
  const h = 0.5
  // Canopy sits below the tip, where a real crown's mass is.
  const canopyY = 0.72

  const verts = [
    // Vertical quad in the XY plane.
    -h, 0, 0, h, 0, 0, h, 1, 0, -h, 0, 0, h, 1, 0, -h, 1, 0,
    // Vertical quad in the ZY plane.
    0, 0, -h, 0, 0, h, 0, 1, h, 0, 0, -h, 0, 1, h, 0, 1, -h,
    // Horizontal canopy quad.
    -h, canopyY, -h, h, canopyY, -h, h, canopyY, h,
    -h, canopyY, -h, h, canopyY, h, -h, canopyY, h,
  ]
  // Normals point mostly UP, not out along the quad's facing.
  //
  // This is the single most important detail in this geometry. With true
  // outward-facing normals and DoubleSide, three flips the normal on back faces,
  // so every billboard facing away from the sun receives ambient only — half of
  // all foliage renders near-black regardless of what colour it is set to.
  //
  // Real foliage is lit from above by the sky and sun through a canopy, not like
  // a flat wall, so biasing the normals upward is both cheaper and more accurate
  // than trying to make the flat-wall interpretation work. A slight sideways
  // component is kept so the two crossed quads are not identically lit.
  const up = 0.94
  const out = 0.34
  const normals = [
    0, up, out, 0, up, out, 0, up, out, 0, up, out, 0, up, out, 0, up, out,
    out, up, 0, out, up, 0, out, up, 0, out, up, 0, out, up, 0, out, up, 0,
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
  ]
  // Side tile occupies u in [0, 0.5); top tile u in [0.5, 1]. A small inset
  // keeps bilinear filtering from bleeding one tile into the other.
  const e = 0.002
  const sideU0 = e
  const sideU1 = 0.5 - e
  const topU0 = 0.5 + e
  const topU1 = 1 - e
  const uvs = [
    sideU0, 0, sideU1, 0, sideU1, 1, sideU0, 0, sideU1, 1, sideU0, 1,
    sideU0, 0, sideU1, 0, sideU1, 1, sideU0, 0, sideU1, 1, sideU0, 1,
    topU0, 0, topU1, 0, topU1, 1, topU0, 0, topU1, 1, topU0, 1,
  ]

  g.setAttribute('position', new Float32BufferAttribute(verts, 3))
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
  return g
}

/** Thin vertical box for a trunk, centred on its base. */
function trunkGeometry(): BufferGeometry {
  const g = new BufferGeometry()
  const w = 0.5
  const faces: number[] = []
  const normals: number[] = []
  const push = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
  ): void => {
    faces.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz)
    for (let i = 0; i < 6; i++) normals.push(nx, ny, nz)
  }
  push(-w, 0, w, w, 0, w, w, 1, w, -w, 1, w, 0, 0, 1)
  push(w, 0, -w, -w, 0, -w, -w, 1, -w, w, 1, -w, 0, 0, -1)
  push(w, 0, w, w, 0, -w, w, 1, -w, w, 1, w, 1, 0, 0)
  push(-w, 0, -w, -w, 0, w, -w, 1, w, -w, 1, -w, -1, 0, 0)
  g.setAttribute('position', new Float32BufferAttribute(faces, 3))
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  return g
}

interface SpeciesBatch {
  species: Species
  crowns: InstancedMesh
  trunks: InstancedMesh | null
  count: number
}

export interface VegetationStats {
  /** Instances placed this rebuild, summed over species. */
  instances: number
  /** True if any species hit its instance cap and plants were dropped. */
  saturated: boolean
}

export class Vegetation {
  readonly group = new Group()
  readonly stats: VegetationStats = { instances: 0, saturated: false }

  private readonly heightfield: Heightfield
  private readonly batches: SpeciesBatch[] = []
  private readonly matrix = new Matrix4()
  private readonly position = new Vector3()
  private readonly quaternion = new Quaternion()
  private readonly scale = new Vector3()
  private readonly color = new Color()
  /** Scratch list of placement positions, reused per cell. */
  private readonly slots: number[] = []
  /** Cell the camera occupied at the last rebuild, so we only rebuild on moves. */
  private lastCellX = Number.NaN
  private lastCellZ = Number.NaN
  private readonly foliage: ReturnType<typeof createFoliageTexture>[] = []

  /**
   * Optional building-occupancy test. Without it, plants are scattered with no
   * knowledge of buildings and visibly grow out of roofs.
   */
  private builtOn: ((x: number, z: number) => boolean) | null = null

  constructor(heightfield: Heightfield) {
    this.heightfield = heightfield

    const crown = crownGeometry()
    const trunk = trunkGeometry()
    // One silhouette per habit, shared by every species using it.
    const foliage = new Map<Habit, ReturnType<typeof createFoliageTexture>>()
    for (const habit of HABITS) {
      foliage.set(habit, createFoliageTexture(habit))
    }
    this.foliage = [...foliage.values()]

    // Trees are real geometry with their own atlases; see tree-geometry.ts and
    // palm.ts. Only the low shrubs still use the billboard crown.
    const palmGeometry = createPalmGeometry()
    const palmTexture = createPalmTexture()
    this.foliage.push(palmTexture)

    const treeGeometry = new Map<TreeKind, BufferGeometry>()
    const treeTexture = new Map<TreeKind, ReturnType<typeof createTreeTexture>>()
    for (const kind of ['pine', 'laurel'] as TreeKind[]) {
      treeGeometry.set(kind, createTreeGeometry(kind))
      const tex = createTreeTexture(kind)
      treeTexture.set(kind, tex)
      this.foliage.push(tex)
    }

    for (const species of ALL_SPECIES) {
      const isPalm = species.build === 'palm'
      const treeKind =
        species.build === 'pine' || species.build === 'laurel'
          ? (species.build as TreeKind)
          : null
      const is3D = isPalm || treeKind !== null
      // Lambert rather than a custom shader: vegetation needs to respond to the
      // same sun direction as the terrain, and this is not where the interesting
      // work is. DoubleSide because billboards are viewed from both faces.
      const crownMat = new MeshLambertMaterial({
        // White, NOT the species colour. three computes
        //   diffuse = material.color * instanceColor * map
        // and the per-instance tint below is already derived from
        // species.crown — so setting it here too squares the colour. In linear
        // space that turns a mid green into near-black, which is exactly what it
        // did: the darker a species' foliage, the more wrong it looked.
        color: 0xffffff,
        side: DoubleSide,
        map: isPalm
          ? palmTexture
          : treeKind
            ? treeTexture.get(treeKind)!
            : foliage.get(species.habit)!,
        // Alpha test, not blending: thousands of overlapping billboards would
        // need per-instance depth sorting to blend correctly. Testing needs none.
        alphaTest: 0.5,
      })
      const crowns = new InstancedMesh(
        isPalm ? palmGeometry : treeKind ? treeGeometry.get(treeKind)! : crown,
        crownMat,
        MAX_PER_SPECIES,
      )
      crowns.frustumCulled = false
      crowns.count = 0
      // Per-instance tint. Without it every plant of a species is exactly the
      // same colour, which is the strongest remaining cue that they are copies.
      crowns.instanceColor = new InstancedBufferAttribute(
        new Float32Array(MAX_PER_SPECIES * 3),
        3,
      )
      this.group.add(crowns)

      let trunks: InstancedMesh | null = null
      // Anything with real geometry carries its own trunk.
      if (species.trunk && !is3D) {
        // Trunks have no per-instance colour, so the species colour belongs here.
        const trunkMat = new MeshLambertMaterial({
          color: species.bark.clone(),
        })
        trunks = new InstancedMesh(trunk, trunkMat, MAX_PER_SPECIES)
        trunks.frustumCulled = false
        trunks.count = 0
        this.group.add(trunks)
      }

      this.batches.push({ species, crowns, trunks, count: 0 })
    }
  }

  /**
   * Rebuild the scatter if the camera has moved to a new cell.
   *
   * Rebuilding only on cell changes rather than every frame is what makes this
   * cheap: at 45 m/s a new cell is entered roughly once a second.
   */
  update(camera: Camera): void {
    camera.getWorldPosition(this.position)
    const cellX = Math.floor(this.position.x / CELL)
    const cellZ = Math.floor(this.position.z / CELL)
    if (cellX === this.lastCellX && cellZ === this.lastCellZ) return
    this.lastCellX = cellX
    this.lastCellZ = cellZ
    this.rebuild(cellX, cellZ)
  }

  private rebuild(centreX: number, centreZ: number): void {
    for (const batch of this.batches) batch.count = 0
    let saturated = false

    const radiusSq = RADIUS * RADIUS
    const slots = this.slots

    for (let dz = -RADIUS; dz <= RADIUS; dz++) {
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        if (dx * dx + dz * dz > radiusSq) continue
        const cx = centreX + dx
        const cz = centreZ + dz

        // One hash per cell drives everything in it. Deriving each plant from
        // (cell, index) keeps placement stable and independent of the order
        // cells happen to be visited in.
        const cellHash = hash(cx, cz)

        // Which biome this cell belongs to decides which species grow here.
        const originX = cx * CELL
        const originZ = cz * CELL
        const biome = this.heightfield.getBiomeAt(originX + CELL / 2, originZ + CELL / 2)
        const species = BIOME_SPECIES[biome]
        if (!species || species.length === 0) continue

        for (const sp of species) {
          const batch = this.batches.find((b) => b.species === sp)
          if (!batch) continue

          // Placement positions for this cell, either scattered or on rows.
          slots.length = 0
          if (sp.planting === 'rows') {
            // A plantation block, with an orientation shared across a coarser
            // grid so neighbouring cells belong to the same field and the rows
            // line up across cell boundaries instead of shattering at them.
            const plotX = Math.floor(originX / PLOT)
            const plotZ = Math.floor(originZ / PLOT)
            const plotHash = hash(plotX, plotZ)
            const angle = hashToUnit(plotHash) * Math.PI
            const ca = Math.cos(angle)
            const sa = Math.sin(angle)
            const spacing = sp.rowSpacing ?? 2.5
            // Walk a lattice in plot-aligned space covering this cell. The
            // lattice is anchored to the plot, not the cell, so rows are
            // continuous across the whole field.
            const steps = Math.ceil((CELL * 1.5) / spacing)
            const baseI = Math.round((originX * ca + originZ * sa) / spacing)
            const baseJ = Math.round((-originX * sa + originZ * ca) / spacing)
            for (let j = 0; j <= steps; j++) {
              for (let i = 0; i <= steps; i++) {
                const li = (baseI + i) * spacing
                const lj = (baseJ + j) * spacing
                // Back to world space.
                const wx = li * ca - lj * sa
                const wz = li * sa + lj * ca
                if (wx < originX || wx >= originX + CELL) continue
                if (wz < originZ || wz >= originZ + CELL) continue
                slots.push(wx, wz)
              }
            }
          } else {
            const perCell = (sp.densityPerKm2 * CELL * CELL) / 1e6
            const whole = Math.floor(perCell)
            // Fractional part handled stochastically but deterministically, so
            // low-density species do not vanish entirely.
            const extra = hashToUnit(cellHash) < perCell - whole ? 1 : 0
            const n = whole + extra
            for (let i = 0; i < n; i++) {
              const a = hash(cellHash ^ (i * 0x9e3779b9), i)
              const b = hash(a, 0x51ed270b)
              slots.push(originX + hashToUnit(a) * CELL, originZ + hashToUnit(b) * CELL)
            }
          }

          for (let s = 0; s < slots.length; s += 2) {
            const px = slots[s] as number
            const pz = slots[s + 1] as number
            const h3 = hash(Math.round(px * 8), Math.round(pz * 8))

            const [, ny] = this.heightfield.getNormalAt(px, pz)
            if (1 - ny > sp.maxSlope) continue
            if (this.builtOn?.(px, pz)) continue

            // Sit on the *rendered* surface, not the bare heightfield, or plants
            // float above and sink into the procedurally displaced ground.
            const py = this.heightfield.getSurfaceHeightAt(px, pz)
            if (py < 1) continue

            if (batch.count >= MAX_PER_SPECIES) {
              saturated = true
              break
            }

            const heightScale =
              sp.height * (1 + (hashToUnit(h3) * 2 - 1) * sp.heightVariance)
            const width = heightScale * sp.crownRatio

            this.position.set(px, py, pz)
            // Yaw only — a plant leaning off vertical reads as broken, and the
            // crossed billboards already look the same from any direction.
            this.quaternion.setFromAxisAngle(
              new Vector3(0, 1, 0),
              hashToUnit(h3) * Math.PI * 2,
            )

            if (sp.build !== 'billboard') {
              // Uniform scale. Real tree geometry already has correct proportions
              // between trunk and crown; scaling the axes independently would
              // stretch the trunk and flatten the foliage.
              this.scale.setScalar(heightScale)
            } else {
              this.scale.set(width, heightScale, width)
            }
            this.matrix.compose(this.position, this.quaternion, this.scale)
            batch.crowns.setMatrixAt(batch.count, this.matrix)

            // Tint each plant slightly. Hue drifts a little and brightness more,
            // which is roughly how a real stand varies.
            const tintA = hashToUnit(hash(h3, 0x1b873593))
            const tintB = hashToUnit(hash(h3, 0x0f2c9b1d))
            this.color
              .copy(sp.crown)
              .multiplyScalar(0.78 + 0.42 * tintA)
              .offsetHSL((tintB - 0.5) * 0.05, (tintA - 0.5) * 0.12, 0)
            batch.crowns.setColorAt(batch.count, this.color)

            if (batch.trunks) {
              // Trunk is thin and reaches the underside of the crown.
              // Kept deliberately thin: at 20-40 m a trunk is a couple of
              // pixels wide, and anything thicker reads as a row of poles.
              const trunkWidth = Math.max(0.1, heightScale * 0.016)
              this.scale.set(trunkWidth, heightScale * 0.62, trunkWidth)
              this.matrix.compose(this.position, this.quaternion, this.scale)
              batch.trunks.setMatrixAt(batch.count, this.matrix)
            }
            batch.count++
          }
        }
      }
    }

    let total = 0
    for (const batch of this.batches) {
      batch.crowns.count = batch.count
      batch.crowns.instanceMatrix.needsUpdate = true
      if (batch.crowns.instanceColor) batch.crowns.instanceColor.needsUpdate = true
      if (batch.trunks) {
        batch.trunks.count = batch.count
        batch.trunks.instanceMatrix.needsUpdate = true
      }
      total += batch.count
    }
    this.stats.instances = total
    this.stats.saturated = saturated
  }

  /** Supply a building-occupancy test so plants avoid footprints. */
  setBuildingMask(test: (x: number, z: number) => boolean): void {
    this.builtOn = test
    // Force a rebuild: the currently placed set was chosen without the mask.
    this.lastCellX = Number.NaN
    this.lastCellZ = Number.NaN
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  dispose(): void {
    for (const texture of this.foliage) texture.dispose()
    for (const batch of this.batches) {
      batch.crowns.geometry.dispose()
      ;(batch.crowns.material as MeshLambertMaterial).dispose()
      batch.crowns.dispose()
      if (batch.trunks) {
        ;(batch.trunks.material as MeshLambertMaterial).dispose()
        batch.trunks.dispose()
      }
    }
  }
}
