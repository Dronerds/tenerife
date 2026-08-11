import { describe, expect, it } from 'vitest'
import { resolveLayers } from '../src/layers'

describe('layer resolution', () => {
  it('shows the photogrammetry alone when it is available and asked for', () => {
    const layers = resolveLayers(true, true)
    expect(layers).toMatchObject({ photoreal: true, globe: false, buildings: false })
    expect(layers.label).toBe('google photoreal')
  })

  it('shows the free stack when the user toggles photoreal off', () => {
    const layers = resolveLayers(false, true)
    expect(layers).toMatchObject({ photoreal: false, globe: true, buildings: true })
    expect(layers.label).toBe('terrain + osm buildings')
  })

  // The reason this module exists. Asking for photoreal when the tileset failed
  // to load has to leave a usable view rather than an empty scene, because the
  // opening default asks for it on every load.
  it('falls back to the free stack when photoreal is unavailable', () => {
    const layers = resolveLayers(true, false)
    expect(layers).toMatchObject({ photoreal: false, globe: true, buildings: true })
  })

  // Distinguishable from a deliberate toggle: the two states look identical on
  // screen, so the label is the only thing telling you the tiles are missing.
  it('says so in the label rather than looking like a toggle', () => {
    expect(resolveLayers(true, false).label).toBe('terrain + osm buildings (photoreal unavailable)')
    expect(resolveLayers(false, false).label).toBe(
      'terrain + osm buildings (photoreal unavailable)',
    )
  })
})
