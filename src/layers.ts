/**
 * Which layers are visible, and what the HUD calls them.
 *
 * Pulled out of main.ts only so the fallback can be tested: it is the one piece
 * of logic that has to stay correct when Google's tiles are missing, and the
 * rest of main.ts needs a WebGL context and a live ion token to run at all.
 */

export interface LayerState {
  /** Show the photogrammetry. False whenever it is unavailable, whatever was asked for. */
  photoreal: boolean
  /** The globe and the extruded buildings are the free stack, and the fallback. */
  globe: boolean
  buildings: boolean
  label: string
}

/**
 * @param requested what the user asked for — the P key, or the opening default
 * @param available whether the photorealistic tileset actually loaded
 */
export function resolveLayers(requested: boolean, available: boolean): LayerState {
  const photoreal = requested && available
  return {
    photoreal,
    // The photogrammetry already contains the ground and the buildings, so
    // drawing them underneath it would z-fight against two surfaces of its own.
    globe: !photoreal,
    buildings: !photoreal,
    // Names the fallback explicitly rather than letting it look like the user
    // pressed P: an unavailable layer is worth noticing, a toggled one is not.
    label: photoreal
      ? 'google photoreal'
      : available
        ? 'terrain + osm buildings'
        : 'terrain + osm buildings (photoreal unavailable)',
  }
}
