/**
 * The single base mesh shared by every terrain node.
 *
 * A flat unit grid on the XZ plane. Every visible quadtree node draws this same
 * geometry, positioned and scaled by per-instance attributes, so the whole
 * terrain is one draw call regardless of how many nodes are selected.
 */

import { InstancedBufferGeometry, BufferAttribute, InstancedBufferAttribute } from 'three'

/** Attribute buffers that are rewritten each frame from the node selection. */
export interface InstanceBuffers {
  offset: InstancedBufferAttribute
  scale: InstancedBufferAttribute
  morphRange: InstancedBufferAttribute
  depth: InstancedBufferAttribute
}

export interface ChunkGeometry {
  geometry: InstancedBufferGeometry
  instances: InstanceBuffers
}

/**
 * Build the shared grid plus empty instance buffers.
 *
 * @param dim       quads per side
 * @param maxNodes  instance capacity; selection is clamped to this
 */
export function createChunkGeometry(dim: number, maxNodes: number): ChunkGeometry {
  const side = dim + 1
  const vertexCount = side * side

  // Positions are XZ in [0,1] with Y unused — the vertex shader replaces Y with
  // the sampled elevation.
  const positions = new Float32Array(vertexCount * 3)
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      const i = (r * side + c) * 3
      positions[i] = c / dim
      positions[i + 1] = 0
      positions[i + 2] = r / dim
    }
  }

  // 16-bit indices suffice while (dim + 1)^2 stays under 65536; at dim = 64
  // that is 4225, with plenty of headroom.
  const indices = new Uint16Array(dim * dim * 6)
  let k = 0
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      const a = r * side + c
      const b = a + 1
      const d = a + side
      const e = d + 1
      indices[k++] = a
      indices[k++] = d
      indices[k++] = b
      indices[k++] = b
      indices[k++] = d
      indices[k++] = e
    }
  }

  const geometry = new InstancedBufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setIndex(new BufferAttribute(indices, 1))

  const instances: InstanceBuffers = {
    offset: new InstancedBufferAttribute(new Float32Array(maxNodes * 2), 2),
    scale: new InstancedBufferAttribute(new Float32Array(maxNodes), 1),
    morphRange: new InstancedBufferAttribute(new Float32Array(maxNodes * 2), 2),
    depth: new InstancedBufferAttribute(new Float32Array(maxNodes), 1),
  }
  for (const attr of Object.values(instances)) attr.setUsage(35048 /* DynamicDrawUsage */)

  geometry.setAttribute('aOffset', instances.offset)
  geometry.setAttribute('aScale', instances.scale)
  geometry.setAttribute('aMorphRange', instances.morphRange)
  geometry.setAttribute('aDepth', instances.depth)

  // Node bounding boxes are handled by the quadtree's own frustum test, and the
  // vertex shader displaces geometry far outside this unit cube, so three.js
  // must not cull based on the base geometry's bounds.
  geometry.boundingSphere = null
  geometry.boundingBox = null

  return { geometry, instances }
}
