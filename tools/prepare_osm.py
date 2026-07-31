#!/usr/bin/env python3
"""
Build `public/data/osm.json` — roads, buildings, water and land-use polygons from
OpenStreetMap.

This is the layer that must be *real*. Terrain shape comes from a DEM and
everything within 30 m is synthesised, but roads and buildings cannot be
invented: a procedural road network over a real island looks wrong to anyone who
knows the place, and the whole point of Tenerife rather than a fictional island is
that it can be checked against reality.

Source is the Geofabrik Canary Islands extract, which is small (~40 MB) and needs
no API key or rate limiting — unlike the Overpass API, which would take many
requests and is unkind to hammer.

Coordinates are emitted already projected into island-local metres, so the
runtime does no geographic maths and cannot disagree with the terrain about where
anything is.

Land-use and natural polygons are extracted here but consumed by
`prepare_landcover.py`, which burns them over the ESA WorldCover raster. OSM's
forest, orchard and farmland boundaries are sharper and more accurate than a 10 m
satellite classification, and they know things the classifier cannot — that a
plantation is an orchard rather than generic "tree cover". Run this script before
prepare_landcover.py.

Usage:
    python3 tools/prepare_osm.py [--force]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.request
from pathlib import Path

import grid

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = Path(__file__).resolve().parent / "data"
OUT_DIR = REPO_ROOT / "public" / "data"

PBF_URL = "https://download.geofabrik.de/africa/canary-islands-latest.osm.pbf"
PBF_NAME = "canary-islands-latest.osm.pbf"

MANIFEST_VERSION = 1

# Road classes we keep, with a rendered width in metres. Tenerife's TF-1/TF-5
# are dual carriageways; the mountain roads are barely two lanes.
ROAD_WIDTHS = {
    "motorway": 22.0,
    "motorway_link": 10.0,
    "trunk": 16.0,
    "trunk_link": 9.0,
    "primary": 11.0,
    "primary_link": 7.0,
    "secondary": 9.0,
    "secondary_link": 6.0,
    "tertiary": 7.0,
    "unclassified": 5.0,
    "residential": 5.5,
    "service": 4.0,
    "track": 3.2,
}

# Water: polygons that are open water, and lines that are channels. Tenerife's
# barrancos are mapped as intermittent streams and are a defining feature of the
# landscape — deep dry gorges radiating off the massif.
WATER_AREA_TAGS = {
    ("natural", "water"),
    ("waterway", "riverbank"),
    ("landuse", "reservoir"),
    ("landuse", "basin"),
}
WATERWAY_WIDTHS = {
    "river": 12.0,
    "stream": 4.0,
    "canal": 5.0,
    "ditch": 2.0,
}

# Land cover from OSM, mapped onto the compacted classes in
# src/geo/landcover.ts. These override WorldCover where present.
LANDCOVER_TAGS: dict[tuple[str, str], int] = {
    # 1 = tree cover
    ("natural", "wood"): 1,
    ("landuse", "forest"): 1,
    # 2 = shrubland
    ("natural", "scrub"): 2,
    ("natural", "heath"): 2,
    # 3 = grassland
    ("natural", "grassland"): 3,
    ("landuse", "meadow"): 3,
    ("landuse", "grass"): 3,
    ("leisure", "park"): 3,
    ("leisure", "garden"): 3,
    ("leisure", "pitch"): 3,
    # 4 = cropland. Orchard and vineyard matter here: Tenerife's banana
    # plantations and terraces are tagged this way, and WorldCover misses almost
    # all of them because they sit under plastic and netting.
    ("landuse", "orchard"): 4,
    ("landuse", "vineyard"): 4,
    ("landuse", "farmland"): 4,
    ("landuse", "plant_nursery"): 4,
    ("landuse", "greenhouse_horticulture"): 4,
    # 5 = built-up
    ("landuse", "residential"): 5,
    ("landuse", "industrial"): 5,
    ("landuse", "commercial"): 5,
    ("landuse", "retail"): 5,
    # 6 = bare
    ("natural", "bare_rock"): 6,
    ("natural", "scree"): 6,
    ("natural", "sand"): 6,
    ("natural", "shingle"): 6,
}

# Metres per storey where a building declares levels but no explicit height.
STOREY_HEIGHT = 3.1

# Buildings with neither a height nor a levels tag get a height derived from
# their position and footprint at *render* time, not a constant here.
#
# Roughly half of OSM's buildings in this extract are untagged, and giving them
# all one fallback height is what made terraces read as a single extruded slab:
# twenty adjacent houses at exactly the same height with flat roofs is
# geometrically one long block, whatever colour each is painted. A varied
# roofline is the strongest cue that a row is made of separate houses.
#
# Emitted as height = 0 to mean "unknown", so the renderer can tell a genuine
# tagged height from a guess.
UNKNOWN_HEIGHT = 0.0


def download_pbf() -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    dest = CACHE_DIR / PBF_NAME
    if dest.exists():
        print(f"  cached {PBF_NAME}")
        return dest
    print(f"  downloading {PBF_NAME} (~40 MB) …", flush=True)
    tmp = dest.with_suffix(".partial")
    try:
        urllib.request.urlretrieve(PBF_URL, tmp)
        tmp.rename(dest)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return dest


# --- Projection, duplicated from src/geo/projection.ts ------------------------
# Deliberately not via pyproj: this must agree exactly with the TypeScript, and
# the surest way to guarantee that is to run the same series with the same
# constants. `test/geo.test.ts` pins the reference points on the other side.

_A = 6378137.0
_F = 1 / 298.257223563
_E2 = _F * (2 - _F)
_EP2 = _E2 / (1 - _E2)
_K0 = 0.9996
_FALSE_EASTING = 500000.0
_CM = -15.0


def _meridian_arc(lat: float) -> float:
    return _A * (
        (1 - _E2 / 4 - 3 * _E2**2 / 64 - 5 * _E2**3 / 256) * lat
        - (3 * _E2 / 8 + 3 * _E2**2 / 32 + 45 * _E2**3 / 1024) * math.sin(2 * lat)
        + (15 * _E2**2 / 256 + 45 * _E2**3 / 1024) * math.sin(4 * lat)
        - (35 * _E2**3 / 3072) * math.sin(6 * lat)
    )


def lonlat_to_local(lon: float, lat: float) -> tuple[float, float]:
    """Geographic to island-local metres. +x east, +z south."""
    phi = math.radians(lat)
    sin_phi = math.sin(phi)
    cos_phi = math.cos(phi)
    tan_phi = math.tan(phi)

    n = _A / math.sqrt(1 - _E2 * sin_phi * sin_phi)
    t = tan_phi * tan_phi
    c = _EP2 * cos_phi * cos_phi
    a = math.radians(lon - _CM) * cos_phi
    m = _meridian_arc(phi)

    east = (
        _K0
        * n
        * (
            a
            + (1 - t + c) * a**3 / 6
            + (5 - 18 * t + t * t + 72 * c - 58 * _EP2) * a**5 / 120
        )
        + _FALSE_EASTING
    )
    north = _K0 * (
        m
        + n
        * tan_phi
        * (
            a * a / 2
            + (5 - t + 9 * c + 4 * c * c) * a**4 / 24
            + (61 - 58 * t + t * t + 600 * c - 330 * _EP2) * a**6 / 720
        )
    )
    return east - grid.ORIGIN_EAST, -(north - grid.ORIGIN_NORTH)


def parse_height(tags: dict) -> float:
    """Height in metres from tags, or UNKNOWN_HEIGHT if the building has none."""
    raw = tags.get("height") or tags.get("building:height")
    if raw:
        try:
            # Strip units; OSM heights are metres by convention but not always tidy.
            return max(2.0, float(str(raw).replace("m", "").strip()))
        except ValueError:
            pass
    levels = tags.get("building:levels")
    if levels:
        try:
            return max(2.0, float(str(levels).strip()) * STOREY_HEIGHT)
        except ValueError:
            pass
    return UNKNOWN_HEIGHT


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "osm.json"
    if out_path.exists() and not args.force:
        sys.exit(f"{out_path} already exists — pass --force to rebuild")

    try:
        import osmium
    except ImportError:
        sys.exit(
            "this step needs pyosmium:\n"
            "  tools/.venv/bin/pip install osmium\n"
            "(it reads the .osm.pbf format, which is a protobuf, not XML)"
        )

    pbf = download_pbf()

    bounds = {
        "minX": grid.GRID_MIN_X,
        "maxX": grid.GRID_MIN_X + (grid.GRID_WIDTH - 1) * grid.RESOLUTION,
        "minZ": grid.GRID_MIN_Z,
        "maxZ": grid.GRID_MIN_Z + (grid.GRID_HEIGHT - 1) * grid.RESOLUTION,
    }

    def inside(x: float, z: float) -> bool:
        return (
            bounds["minX"] <= x <= bounds["maxX"]
            and bounds["minZ"] <= z <= bounds["maxZ"]
        )

    class Handler(osmium.SimpleHandler):
        def __init__(self) -> None:
            super().__init__()
            self.roads: list[dict] = []
            self.buildings: list[dict] = []
            self.walls: list[dict] = []
            self.water: list[dict] = []
            self.waterways: list[dict] = []
            self.landcover: list[dict] = []
            self.skipped_outside = 0

        def way(self, w) -> None:
            tags = {t.k: t.v for t in w.tags}

            highway = tags.get("highway")
            building = tags.get("building")
            barrier = tags.get("barrier")
            waterway = tags.get("waterway")

            # Which land-cover class, if any, this polygon represents.
            cover = None
            for key, value in tags.items():
                cover = LANDCOVER_TAGS.get((key, value))
                if cover is not None:
                    break
            is_water_area = any((k, v) in WATER_AREA_TAGS for k, v in tags.items())

            if (
                highway not in ROAD_WIDTHS
                and not building
                and barrier != "wall"
                and waterway not in WATERWAY_WIDTHS
                and cover is None
                and not is_water_area
            ):
                return

            try:
                pts = [lonlat_to_local(n.lon, n.lat) for n in w.nodes]
            except osmium.InvalidLocationError:
                # Ways referencing nodes outside the extract; there are a few at
                # the edges and they are not recoverable.
                return
            if len(pts) < 2:
                return

            # The extract covers all seven islands, so most of it is elsewhere.
            if not any(inside(x, z) for x, z in pts):
                self.skipped_outside += 1
                return

            closed = pts[0] == pts[-1] and len(pts) >= 4

            if is_water_area and closed:
                # Closed ways only: multipolygon relations are not handled, so
                # lakes with islands and complex reservoirs are missed. Tenerife
                # has very little standing water, so the loss is small.
                self.water.append(
                    {"ring": [round(v, 1) for p in pts[:-1] for v in p]}
                )
                return

            if waterway in WATERWAY_WIDTHS and not closed:
                self.waterways.append(
                    {
                        "path": [round(v, 1) for p in pts for v in p],
                        "width": WATERWAY_WIDTHS[waterway],
                        "class": waterway,
                    }
                )
                return

            if cover is not None and closed and not building:
                self.landcover.append(
                    {
                        "ring": [round(v, 1) for p in pts[:-1] for v in p],
                        "cover": cover,
                    }
                )
                return

            if building:
                if len(pts) < 4:
                    return
                # Drop the repeated closing node; the renderer closes the ring.
                ring = pts[:-1] if pts[0] == pts[-1] else pts
                if len(ring) < 3:
                    return
                self.buildings.append(
                    {
                        "ring": [round(v, 1) for p in ring for v in p],
                        "height": round(parse_height(tags), 1),
                    }
                )
            elif highway in ROAD_WIDTHS:
                self.roads.append(
                    {
                        "path": [round(v, 1) for p in pts for v in p],
                        "width": ROAD_WIDTHS[highway],
                        "class": highway,
                    }
                )
            elif barrier == "wall":
                self.walls.append({"path": [round(v, 1) for p in pts for v in p]})

    print("  reading ways …", flush=True)
    handler = Handler()
    handler.apply_file(str(pbf), locations=True)

    payload = {
        "version": MANIFEST_VERSION,
        "originEast": grid.ORIGIN_EAST,
        "originNorth": grid.ORIGIN_NORTH,
        "bounds": bounds,
        "note": "coordinates are island-local metres; +x east, +z south",
        "roads": handler.roads,
        "buildings": handler.buildings,
        "walls": handler.walls,
        "water": handler.water,
        "waterways": handler.waterways,
        # Consumed by prepare_landcover.py, not by the renderer.
        "landcover": handler.landcover,
    }
    out_path.write_text(json.dumps(payload, separators=(",", ":")))

    mb = out_path.stat().st_size / 1e6
    print(f"\nwrote {out_path.relative_to(REPO_ROOT)}  ({mb:.1f} MB)")
    print(f"  roads      {len(handler.roads):,}")
    print(f"  buildings  {len(handler.buildings):,}")
    print(f"  walls      {len(handler.walls):,}")
    print(f"  water      {len(handler.water):,} polygons")
    print(f"  waterways  {len(handler.waterways):,}")
    print(f"  landcover  {len(handler.landcover):,} polygons")
    print(f"  ways outside the grid, skipped: {handler.skipped_outside:,}")


if __name__ == "__main__":
    main()
