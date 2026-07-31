/**
 * A placeholder sea plane at mean sea level.
 *
 * Purely so the island reads as an island in M2 — there is no wave model, no
 * shoreline foam and no refraction. Real water belongs with the atmosphere work
 * in M8. It is sized well beyond the heightfield so the horizon stays water in
 * every direction.
 */

import { Color, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three'

const SEA_EXTENT = 400_000

/**
 * Shared by the sea plane and the terrain shader.
 *
 * The height grid is a rectangle that extends well past the coastline, so the
 * ocean is drawn twice: as terrain at elevation zero out to the edge of the
 * data, and as this plane beyond it. Both must use exactly this colour or a
 * hard rectangular seam appears at the edge of the grid.
 */
export const SEA_COLOR = new Color(0x0d2b3e)

export function createSea(): Mesh {
  const geometry = new PlaneGeometry(SEA_EXTENT, SEA_EXTENT)
  geometry.rotateX(-Math.PI / 2)
  const material = new MeshBasicMaterial({ color: SEA_COLOR })
  const mesh = new Mesh(geometry, material)
  // Just below datum, so coastal cells that resample to a hair under zero do
  // not z-fight with the water.
  mesh.position.y = -0.5
  mesh.renderOrder = -1
  return mesh
}
