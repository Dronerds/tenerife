#!/usr/bin/env python3
"""
Build `public/data/landcover.bin` — ESA WorldCover 10 m, resampled to the island
grid.

This replaces the *input* to biome classification, not the classification itself.
Until now biomes were inferred from elevation x slope x aspect, which is accurate
for Tenerife's textbook altitudinal banding but cannot know where a town, a road
or an actual banana plantation is. WorldCover is observed, so it knows.

Elevation still matters and is still used: WorldCover says "tree cover" but not
*which* trees, and the difference between laurisilva at 800 m and Canary pine at
1600 m is most of the island's character. So the runtime combines the two —
observed cover for what is there, elevation and aspect to disambiguate species.

Resampled with **mode** (most common value in the footprint), not bilinear or
nearest: these are categorical class ids, and averaging class 10 with class 50
would produce class 30, i.e. inventing grassland between a forest and a town.

**OSM land-use polygons are burned over the top**, where present. WorldCover is a
10 m satellite classification and OSM is surveyed, so OSM wins on boundaries and
knows things a classifier cannot: that a given stand of trees is an orchard rather
than generic "tree cover", and where a plantation sits under plastic. That last
point matters a lot here — WorldCover labels only 0.22% of this grid as cropland
because Tenerife's banana terraces are netted, and OSM labels them properly.

Requires `public/data/osm.json`, so run prepare_osm.py first. Without it this
falls back to WorldCover alone.

Output is one byte per grid sample, aligned exactly to heights.bin.

Usage:
    python3 tools/prepare_landcover.py [--force]
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.warp import reproject

import grid

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = Path(__file__).resolve().parent / "data"
OUT_DIR = REPO_ROOT / "public" / "data"

WORLDCOVER_BASE = (
    "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map"
)
# WorldCover tiles are 3x3 degrees on a grid of multiples of 3. N27W018 covers
# 27-30 N, 18-15 W, which contains the whole of Tenerife.
WORLDCOVER_TILE = "ESA_WorldCover_10m_2021_v200_N27W018_Map.tif"

# WorldCover class ids, for reference in the mapping below.
WORLDCOVER_CLASSES = {
    10: "tree cover",
    20: "shrubland",
    30: "grassland",
    40: "cropland",
    50: "built-up",
    60: "bare / sparse vegetation",
    70: "snow and ice",
    80: "permanent water",
    90: "herbaceous wetland",
    95: "mangroves",
    100: "moss and lichen",
    0: "nodata (treated as water)",
}

# Compacted to 0..10 so the runtime can index a small lookup table instead of
# branching on the sparse original ids.
CLASS_REMAP = {
    0: 0,  # nodata -> treated as water
    80: 0,
    10: 1,  # tree cover
    20: 2,  # shrubland
    30: 3,  # grassland
    40: 4,  # cropland
    50: 5,  # built-up
    60: 6,  # bare
    70: 7,  # snow and ice
    90: 8,  # wetland
    95: 8,
    100: 9,  # moss and lichen
}

MANIFEST_VERSION = 1


def fetch_tile() -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    dest = CACHE_DIR / WORLDCOVER_TILE
    if dest.exists():
        print(f"  cached {WORLDCOVER_TILE}")
        return dest
    print(f"  downloading {WORLDCOVER_TILE} …", flush=True)
    tmp = dest.with_suffix(".partial")
    try:
        urllib.request.urlretrieve(f"{WORLDCOVER_BASE}/{WORLDCOVER_TILE}", tmp)
        tmp.rename(dest)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return dest


def ring_area(ring: list[float]) -> float:
    """Absolute polygon area from a flat [x, z, x, z, ...] ring, m2."""
    n = len(ring) // 2
    total = 0.0
    for i in range(n):
        j = (i + 1) % n
        total += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1]
    return abs(total) / 2


def burn_osm(base: np.ndarray) -> np.ndarray:
    """
    Overlay OSM land-use and water polygons onto the WorldCover classes.

    Polygons are burned **largest first**, so a small specific polygon (an orchard
    inside a farmland block) overwrites the general one containing it rather than
    being buried by it. Water goes last because it is the most reliable of the lot
    and should never be overwritten by a vegetation polygon that overlaps it.
    """
    osm_path = OUT_DIR / "osm.json"
    if not osm_path.exists():
        print("  no osm.json — using WorldCover alone (run prepare_osm.py first)")
        return base

    payload = json.loads(osm_path.read_text())
    polys = payload.get("landcover") or []
    water = payload.get("water") or []
    if not polys and not water:
        return base

    def to_utm(ring: list[float]) -> list[tuple[float, float]]:
        # Local metres to UTM: +x is east, +z is south.
        return [
            (ring[i * 2] + grid.ORIGIN_EAST, grid.ORIGIN_NORTH - ring[i * 2 + 1])
            for i in range(len(ring) // 2)
        ]

    shapes: list[tuple[dict, int]] = []
    ordered = sorted(polys, key=lambda p: -ring_area(p["ring"]))
    for poly in ordered:
        coords = to_utm(poly["ring"])
        if len(coords) < 3:
            continue
        shapes.append(({"type": "Polygon", "coordinates": [coords + [coords[0]]]}, poly["cover"]))
    for poly in water:
        coords = to_utm(poly["ring"])
        if len(coords) < 3:
            continue
        shapes.append(({"type": "Polygon", "coordinates": [coords + [coords[0]]]}, 0))

    print(f"  burning {len(shapes):,} OSM polygons over WorldCover …", flush=True)
    # all_touched=False so a polygon must cover a cell centre to claim it; with
    # all_touched every thin sliver would claim a full 30 m cell and OSM's dense
    # small polygons would swamp the raster.
    burned = rasterize(
        shapes,
        out=base.copy(),
        transform=grid.target_transform(),
        all_touched=False,
        default_value=0,
    )
    changed = int((burned != base).sum())
    print(f"  OSM changed {100 * changed / base.size:.2f}% of cells")
    return burned


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    bin_path = OUT_DIR / "landcover.bin"
    json_path = OUT_DIR / "landcover.json"
    if bin_path.exists() and not args.force:
        sys.exit(f"{bin_path} already exists — pass --force to rebuild")

    source = fetch_tile()

    print(f"  reprojecting to {grid.UTM_EPSG} at {grid.RESOLUTION:.0f} m …", flush=True)
    out = np.zeros((grid.GRID_HEIGHT, grid.GRID_WIDTH), dtype=np.uint8)
    with rasterio.open(source) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=out,
            dst_transform=grid.target_transform(),
            dst_crs=grid.UTM_EPSG,
            dst_nodata=0,
            # Mode, not nearest: the source is 10 m and the target 30 m, so each
            # output cell covers ~9 input cells. Mode picks the dominant class,
            # which keeps narrow features like roads from randomly winning or
            # losing a cell depending on sub-pixel alignment.
            resampling=Resampling.mode,
        )

    present = {int(k): int(v) for k, v in zip(*np.unique(out, return_counts=True))}
    unknown = sorted(set(present) - set(CLASS_REMAP))
    if unknown:
        print(f"  WARNING: unmapped WorldCover classes {unknown}", file=sys.stderr)

    remapped = np.zeros_like(out)
    for raw, compact in CLASS_REMAP.items():
        remapped[out == raw] = compact

    burned = burn_osm(remapped)

    burned.tofile(bin_path)
    manifest = {
        "version": MANIFEST_VERSION,
        "width": grid.GRID_WIDTH,
        "height": grid.GRID_HEIGHT,
        "resolution": grid.RESOLUTION,
        "source": "ESA WorldCover 10m v200 (2021)",
        "classes": {
            "0": "water",
            "1": "tree cover",
            "2": "shrubland",
            "3": "grassland",
            "4": "cropland",
            "5": "built-up",
            "6": "bare",
            "7": "snow and ice",
            "8": "wetland",
            "9": "moss and lichen",
        },
    }
    json_path.write_text(json.dumps(manifest, indent=2) + "\n")

    print(f"\nwrote {bin_path.relative_to(REPO_ROOT)}  ({bin_path.stat().st_size / 1e6:.1f} MB)")
    print(f"wrote {json_path.relative_to(REPO_ROOT)}")

    # Report the *final* distribution, after the OSM burn. Reporting the raw
    # WorldCover counts here was misleading: it showed the input, not the output.
    names = manifest["classes"]
    land = int((burned != 0).sum())
    print("\n  final class distribution (share of land, water excluded):")
    for cls, count in sorted(
        zip(*np.unique(burned, return_counts=True)), key=lambda kv: -kv[1]
    ):
        if cls == 0:
            continue
        label = names.get(str(int(cls)), f"class {int(cls)}")
        print(f"    {label:<28} {100 * count / land:5.2f}%")


if __name__ == "__main__":
    main()
