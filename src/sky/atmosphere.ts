/**
 * Placeholder aerial perspective.
 *
 * A single exponential-squared haze, shared by the scene fog (which the sea
 * plane and any future built-in materials pick up automatically) and the
 * terrain shader (which computes it by hand). Both must use the same colour and
 * density, or the terrain and the sea diverge with distance and the edge of the
 * height grid reappears as a seam on the horizon.
 *
 * A real atmospheric model — Rayleigh scattering, sun position, and the
 * mar de nubes — arrives in M8.
 */

import { Color, FogExp2 } from 'three'

export const HAZE_COLOR = new Color(0xa0b4c8)

/**
 * Chosen so the far side of the island (~50 km) is mostly washed out while
 * near-field detail stays crisp.
 */
export const HAZE_DENSITY = 2.4e-5

export function createFog(): FogExp2 {
  return new FogExp2(HAZE_COLOR.getHex(), HAZE_DENSITY)
}
