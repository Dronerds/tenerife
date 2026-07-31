#!/usr/bin/env python3
"""
Build `public/data/heights.bin` + `heights.json` — the resident heightfield.

Sources:

  --source fabdem       (default) FABDEM v1.2 — Copernicus GLO-30 with forests
                        and buildings machine-removed. Bare earth is what we
                        want, because we synthesise our own vegetation and
                        extrude our own buildings on top; a surface model would
                        leave us placing trees on top of tree-shaped bumps.

                        The official distribution is behind a click-through
                        licence, but the full v1.2 tile set is mirrored
                        ungated on Hugging Face, so it downloads unattended.

  --source copernicus   Copernicus GLO-30 DSM from the AWS Open Data bucket.
                        A *surface* model — trees and buildings included. Kept
                        as a fallback if the mirror ever disappears.

The two are pixel-aligned (FABDEM is derived from GLO-30), so swapping between
them changes only the elevations, never the grid.

Note FABDEM is CC BY-NC-SA 4.0 — non-commercial only.

Usage:
    python3 tools/prepare_heights.py [--source fabdem|copernicus] [--force]
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
from rasterio.merge import merge
from rasterio.warp import reproject

import grid

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = Path(__file__).resolve().parent / "data"
OUT_DIR = REPO_ROOT / "public" / "data"

COPERNICUS_BASE = "https://copernicus-dem-30m.s3.amazonaws.com"

# Ungated mirror of the full FABDEM v1.2 tile set. Tiles are grouped into
# 10x10 degree directories; Tenerife falls in the N20W020-N30W010 block.
FABDEM_BASE = (
    "https://huggingface.co/datasets/links-ads/fabdem-v12/resolve/main/"
    "tiles/N20W020-N30W010_FABDEM_V1-2"
)

# 1x1 degree tiles covering the bbox. Longitude -16.95..-16.10 falls entirely
# within the W017 column; latitude 27.98..28.61 straddles the N27 and N28 rows.
# (The N27 tile holds only the island's southern tip, so it is mostly ocean.)
COPERNICUS_TILES = ["N27_00_W017_00", "N28_00_W017_00"]
FABDEM_TILES = ["N27W017_FABDEM_V1-2.tif", "N28W017_FABDEM_V1-2.tif"]


def download(url: str, dest: Path) -> None:
    """Fetch to a temporary file then rename, so an interrupted run never leaves
    a truncated tile in the cache that later runs would treat as complete."""
    print(f"  downloading {dest.name} …", flush=True)
    tmp = dest.with_suffix(dest.suffix + ".partial")
    try:
        urllib.request.urlretrieve(url, tmp)
        tmp.rename(dest)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def fetch_copernicus() -> list[Path]:
    """Download the Copernicus GLO-30 COGs we need, caching in tools/data/."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    paths = []
    for tile in COPERNICUS_TILES:
        name = f"Copernicus_DSM_COG_10_{tile}_DEM.tif"
        dest = CACHE_DIR / name
        if dest.exists():
            print(f"  cached {name}")
        else:
            download(f"{COPERNICUS_BASE}/Copernicus_DSM_COG_10_{tile}_DEM/{name}", dest)
        paths.append(dest)
    return paths


def fetch_fabdem() -> list[Path]:
    """Download FABDEM v1.2 tiles from the ungated Hugging Face mirror."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    paths = []
    for name in FABDEM_TILES:
        dest = CACHE_DIR / name
        if dest.exists():
            print(f"  cached {name}")
        else:
            try:
                download(f"{FABDEM_BASE}/{name}", dest)
            except urllib.error.HTTPError as exc:
                sys.exit(
                    f"could not fetch {name} from the Hugging Face mirror ({exc}).\n"
                    "If the mirror has moved, FABDEM's official home is\n"
                    "  https://data.bris.ac.uk/data/dataset/25wfy0f9ukoge2gs7a5mqpq2j7\n"
                    "(click-through licence; extract tiles into tools/data/).\n"
                    "To carry on meanwhile with the Copernicus surface model:\n"
                    "  python3 tools/prepare_heights.py --source copernicus --force"
                )
        paths.append(dest)
    return paths


def resample_to_grid(sources: list[Path]) -> np.ndarray:
    """
    Merge the source tiles and resample onto the island-local UTM grid.

    Bilinear rather than nearest: the source is ~30 m in geographic degrees and
    the target is 30 m in metres, so nearly every output sample falls between
    input samples. Nearest-neighbour here produces a visible stair-stepped
    pattern on shallow slopes that survives all the way into the final render.
    """
    print(f"  merging {len(sources)} tile(s) …", flush=True)
    datasets = [rasterio.open(p) for p in sources]
    try:
        mosaic, mosaic_transform = merge(datasets, resampling=Resampling.bilinear)
        src_crs = datasets[0].crs
        src_nodata = datasets[0].nodata
    finally:
        for d in datasets:
            d.close()

    print(f"  reprojecting to {grid.UTM_EPSG} at {grid.RESOLUTION:.0f} m …", flush=True)
    out = np.full((grid.GRID_HEIGHT, grid.GRID_WIDTH), grid.NODATA, dtype=np.float32)
    reproject(
        source=mosaic[0],
        destination=out,
        src_transform=mosaic_transform,
        src_crs=src_crs,
        src_nodata=src_nodata,
        dst_transform=grid.target_transform(),
        dst_crs=grid.UTM_EPSG,
        dst_nodata=grid.NODATA,
        resampling=Resampling.bilinear,
    )
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=["fabdem", "copernicus"], default="fabdem")
    parser.add_argument(
        "--force", action="store_true", help="rebuild even if outputs exist"
    )
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    bin_path = OUT_DIR / "heights.bin"
    json_path = OUT_DIR / "heights.json"
    if bin_path.exists() and not args.force:
        sys.exit(f"{bin_path} already exists — pass --force to rebuild")

    print(f"source: {args.source}")
    sources = fetch_fabdem() if args.source == "fabdem" else fetch_copernicus()
    heights = resample_to_grid(sources)

    # Everything outside the source coverage in this bbox is open ocean.
    gaps = heights == grid.NODATA
    heights[gaps] = 0.0
    land = heights[~gaps]

    # Sanity check: Teide should show up close to 3715 m. If it does not, the
    # grid transform or the CRS is wrong and nothing downstream will be right.
    peak = float(land.max()) if land.size else 0.0
    if not (3500 <= peak <= 3800):
        print(
            f"  WARNING: highest elevation is {peak:.1f} m; expected Teide at "
            "~3715 m. Check the grid transform in tools/grid.py.",
            file=sys.stderr,
        )

    heights.tofile(bin_path)
    manifest = grid.manifest(float(heights.min()), peak)
    json_path.write_text(json.dumps(manifest, indent=2) + "\n")

    mb = bin_path.stat().st_size / 1e6
    print(f"\nwrote {bin_path.relative_to(REPO_ROOT)}  ({mb:.1f} MB)")
    print(f"wrote {json_path.relative_to(REPO_ROOT)}")
    print(f"  grid       {grid.GRID_WIDTH} x {grid.GRID_HEIGHT} @ {grid.RESOLUTION:.0f} m")
    print(f"  elevation  {heights.min():.1f} .. {peak:.1f} m")
    print(f"  nodata     {int(gaps.sum()):,} samples treated as sea level")


if __name__ == "__main__":
    main()
