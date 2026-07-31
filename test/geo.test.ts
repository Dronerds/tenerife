/**
 * Guards the coordinate contract.
 *
 * These are the failures that are cheap to catch here and expensive to catch
 * later: a flipped north-south axis looks plausible until an OSM road runs up
 * the wrong side of a valley, and a drifted origin silently invalidates every
 * generated asset.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { lonLatToUtm28n, utm28nToLonLat } from '../src/geo/projection.ts'
import {
  GRID,
  ISLAND_BOUNDS,
  ORIGIN_EAST,
  ORIGIN_NORTH,
  localToLonLat,
  lonLatToLocal,
} from '../src/geo/origin.ts'
import { Heightfield, type HeightfieldManifest } from '../src/geo/heightfield.ts'

/** Landmarks with independently known positions. */
const TEIDE = { lon: -16.6425, lat: 28.2724 }
const SANTA_CRUZ = { lon: -16.2518, lat: 28.4682 }

describe('UTM 28N projection', () => {
  it('places Teide at its published UTM coordinate', () => {
    const { east, north } = lonLatToUtm28n(TEIDE)
    expect(east).toBeCloseTo(338900.9, 0)
    expect(north).toBeCloseTo(3128472.1, 0)
  })

  it('round-trips to sub-millimetre across the island', () => {
    for (const lon of [-16.95, -16.6, -16.1]) {
      for (const lat of [27.98, 28.29, 28.61]) {
        const back = utm28nToLonLat(lonLatToUtm28n({ lon, lat }))
        // 1e-8 degrees is roughly 1 mm.
        expect(back.lon).toBeCloseTo(lon, 8)
        expect(back.lat).toBeCloseTo(lat, 8)
      }
    }
  })
})

describe('island-local frame', () => {
  it('round-trips through local metres', () => {
    const back = localToLonLat(lonLatToLocal(TEIDE))
    expect(back.lon).toBeCloseTo(TEIDE.lon, 8)
    expect(back.lat).toBeCloseTo(TEIDE.lat, 8)
  })

  it('puts north at negative Z', () => {
    const teide = lonLatToLocal(TEIDE)
    const santaCruz = lonLatToLocal(SANTA_CRUZ)
    // Santa Cruz is north-east of Teide, so it must be further east (+x) and
    // further north (-z). This is the assertion that catches an axis flip.
    expect(santaCruz.x).toBeGreaterThan(teide.x)
    expect(santaCruz.z).toBeLessThan(teide.z)
  })

  it('keeps every coordinate inside float32 precision comfort', () => {
    // Beyond ~1e5 m, float32 spacing exceeds 1 cm and vertex jitter appears.
    for (const v of Object.values(ISLAND_BOUNDS)) {
      expect(Math.abs(v)).toBeLessThan(100_000)
    }
  })

  it('derives bounds from the grid definition', () => {
    expect(ISLAND_BOUNDS.maxX).toBe(GRID.minX + (GRID.width - 1) * GRID.resolution)
    expect(ISLAND_BOUNDS.maxZ).toBe(GRID.minZ + (GRID.height - 1) * GRID.resolution)
  })

  it('covers the full island bbox including Anaga and Teno', () => {
    const corners = [
      { lon: -16.95, lat: 27.98 },
      { lon: -16.1, lat: 28.61 },
      // Punta de Anaga, the north-east tip.
      { lon: -16.14, lat: 28.57 },
      // Punta de Teno, the north-west tip.
      { lon: -16.92, lat: 28.34 },
    ]
    for (const corner of corners) {
      const { x, z } = lonLatToLocal(corner)
      expect(x).toBeGreaterThanOrEqual(ISLAND_BOUNDS.minX)
      expect(x).toBeLessThanOrEqual(ISLAND_BOUNDS.maxX)
      expect(z).toBeGreaterThanOrEqual(ISLAND_BOUNDS.minZ)
      expect(z).toBeLessThanOrEqual(ISLAND_BOUNDS.maxZ)
    }
  })
})

describe('generated heightfield', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../public/data/heights.json', import.meta.url), 'utf8'),
  ) as HeightfieldManifest

  it('agrees with the TypeScript grid definition', () => {
    expect(manifest.width).toBe(GRID.width)
    expect(manifest.height).toBe(GRID.height)
    expect(manifest.resolution).toBe(GRID.resolution)
    expect(manifest.originEast).toBe(ORIGIN_EAST)
    expect(manifest.originNorth).toBe(ORIGIN_NORTH)
    expect(manifest.bounds).toEqual(ISLAND_BOUNDS)
  })

  describe('sampling', () => {
    const buffer = readFileSync(new URL('../public/data/heights.bin', import.meta.url))
    const samples = new Float32Array(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    )
    const field = new Heightfield(manifest, samples)

    it('resolves Teide close to its true 3715 m', () => {
      const { x, z } = lonLatToLocal(TEIDE)
      const h = field.getHeightAt(x, z)
      // A 30 m grid cannot hold the exact apex of a sharp cone, so allow a
      // clipped summit — but anything below 3600 means the grid is misaligned.
      expect(h).toBeGreaterThan(3600)
      expect(h).toBeLessThan(3720)
    })

    it('puts open ocean at sea level', () => {
      // Well south-west of the island, inside the grid but off the coast.
      const { x, z } = lonLatToLocal({ lon: -16.93, lat: 28.0 })
      expect(Math.abs(field.getHeightAt(x, z))).toBeLessThan(5)
    })

    it('reports Teide as a local maximum', () => {
      const { x, z } = lonLatToLocal(TEIDE)
      const summit = field.getHeightAt(x, z)
      for (const [dx, dz] of [
        [2000, 0],
        [-2000, 0],
        [0, 2000],
        [0, -2000],
      ] as const) {
        expect(field.getHeightAt(x + dx, z + dz)).toBeLessThan(summit)
      }
    })

    it('finds the ground sloping away from the summit', () => {
      const { x, z } = lonLatToLocal(TEIDE)
      // 3 km down the flank the cone is steep; nowhere near flat.
      expect(field.getSlopeAt(x + 3000, z)).toBeGreaterThan(0.15)
    })
  })
})
