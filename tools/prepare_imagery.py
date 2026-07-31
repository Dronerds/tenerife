#!/usr/bin/env python3
"""
Build `public/data/imagery.png` — a cloud-free Sentinel-2 colour composite.

Why a composite rather than one scene: Tenerife's north side sits under the
trade-wind cloud deck a large fraction of the year, so there is essentially no
single date on which the whole island is clear. Taking the **per-pixel median**
across many low-cloud dates removes cloud, because a given pixel is clear in most
scenes even when no scene is clear everywhere.

Resolution: Sentinel-2 visual is 10 m, and this resamples to the 30 m island grid.
That is deliberate — at 10 m the imagery is one pixel per 10 m, which is useless
as near-field detail at 15 m AGL, and the near field is handled by procedural
materials instead. What imagery is genuinely needed for is the *mid and far*
field, where real colour variation reads and procedural biomes look repetitive.

Fetching is cheap because Sentinel-2 on AWS is stored as COGs with overviews:
rasterio reads a reduced-resolution level directly rather than pulling full
10 m tiles and downsampling locally.

Usage:
    python3 tools/prepare_imagery.py [--scenes 12] [--max-cloud 25] [--force]
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import reproject

import grid

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "public" / "data"

STAC_SEARCH = "https://earth-search.aws.element84.com/v1/search"
COLLECTION = "sentinel-2-l2a"
# MGRS tile containing Tenerife.
MGRS_TILE = "28RCS"


def search_scenes(limit: int, max_cloud: float) -> list[dict]:
    """Find low-cloud Sentinel-2 scenes over Tenerife, newest first."""
    query = {
        "collections": [COLLECTION],
        "bbox": [
            grid.BBOX_LON_MIN,
            grid.BBOX_LAT_MIN,
            grid.BBOX_LON_MAX,
            grid.BBOX_LAT_MAX,
        ],
        "datetime": "2023-01-01T00:00:00Z/2025-12-31T23:59:59Z",
        "query": {
            "eo:cloud_cover": {"lt": max_cloud},
            "grid:code": {"eq": f"MGRS-{MGRS_TILE}"},
        },
        "limit": limit,
        "sortby": [{"field": "properties.eo:cloud_cover", "direction": "asc"}],
    }
    request = urllib.request.Request(
        STAC_SEARCH,
        data=json.dumps(query).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        sys.exit(f"STAC search failed: {exc}\n{exc.read().decode()[:500]}")
    return payload.get("features", [])


def read_scene(url: str) -> np.ndarray | None:
    """
    Reproject one scene's true-colour asset onto the island grid.

    Returns an (3, H, W) uint8 array, or None if the scene could not be read —
    individual assets do occasionally 404, and losing one of a dozen is harmless.
    """
    try:
        with rasterio.open(url) as src:
            out = np.zeros(
                (3, grid.GRID_HEIGHT, grid.GRID_WIDTH), dtype=np.uint8
            )
            for band in range(3):
                reproject(
                    source=rasterio.band(src, band + 1),
                    destination=out[band],
                    dst_transform=grid.target_transform(),
                    dst_crs=grid.UTM_EPSG,
                    dst_nodata=0,
                    resampling=Resampling.average,
                )
            return out
    except Exception as exc:  # noqa: BLE001 - any failure means skip this scene
        print(f"    skipped ({type(exc).__name__}: {exc})", file=sys.stderr)
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenes", type=int, default=12)
    parser.add_argument("--max-cloud", type=float, default=25.0)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "imagery.png"
    if out_path.exists() and not args.force:
        sys.exit(f"{out_path} already exists — pass --force to rebuild")

    print(f"searching for up to {args.scenes} scenes under {args.max_cloud}% cloud …")
    features = search_scenes(args.scenes, args.max_cloud)
    if not features:
        sys.exit("no scenes matched — try raising --max-cloud")

    print(f"  {len(features)} scenes:")
    for f in features:
        print(
            f"    {f['properties']['datetime'][:10]}  "
            f"cloud {f['properties'].get('eo:cloud_cover', 0):5.1f}%"
        )

    stack = []
    for i, feature in enumerate(features, 1):
        asset = feature["assets"].get("visual")
        if not asset:
            continue
        print(f"  [{i}/{len(features)}] {feature['properties']['datetime'][:10]} …", flush=True)
        scene = read_scene(asset["href"])
        if scene is not None:
            stack.append(scene)

    if not stack:
        sys.exit("no scenes could be read")

    print(f"\n  compositing {len(stack)} scenes (per-pixel median) …", flush=True)
    cube = np.stack(stack).astype(np.float32)
    # Treat 0 as no-data rather than black, so scene edges and gaps do not drag
    # the median towards black.
    cube[cube == 0] = np.nan
    with np.errstate(all="ignore"):
        composite = np.nanmedian(cube, axis=0)
    composite = np.nan_to_num(composite, nan=0.0)
    composite = np.clip(composite, 0, 255).astype(np.uint8)

    # PNG rather than raw: this is 19 MB uncompressed and compresses well, and
    # the browser decodes it natively into a texture without custom code.
    try:
        from PIL import Image
    except ImportError:
        sys.exit("this step needs Pillow:\n  tools/.venv/bin/pip install pillow")

    rgb = np.transpose(composite, (1, 2, 0))
    Image.fromarray(rgb, mode="RGB").save(out_path, optimize=True)

    manifest = {
        "version": 1,
        "width": grid.GRID_WIDTH,
        "height": grid.GRID_HEIGHT,
        "resolution": grid.RESOLUTION,
        "source": f"Sentinel-2 L2A median composite, {len(stack)} scenes",
        "scenes": [f["properties"]["datetime"][:10] for f in features],
    }
    (OUT_DIR / "imagery.json").write_text(json.dumps(manifest, indent=2) + "\n")

    mb = out_path.stat().st_size / 1e6
    coverage = 100 * float((rgb.sum(axis=2) > 0).mean())
    print(f"\nwrote {out_path.relative_to(REPO_ROOT)}  ({mb:.1f} MB)")
    print(f"  grid      {grid.GRID_WIDTH} x {grid.GRID_HEIGHT}")
    print(f"  non-black {coverage:.1f}% of pixels")


if __name__ == "__main__":
    main()
