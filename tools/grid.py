"""
The island-local grid definition — the Python half of a contract with
`src/geo/origin.ts`.

Both files describe the same coordinate frame and the same sample grid. If you
change one you must change the other; `test/geo.test.ts` asserts the TypeScript
side matches the manifest that these numbers produce.

Coordinate frame: UTM zone 28N (EPSG:32628), shifted so the origin sits near the
centre of the island, then with northings negated so that +Z points south to
match three.js's right-handed +Y-up convention.
"""

from dataclasses import dataclass

# --- Contract with src/geo/origin.ts -----------------------------------------

UTM_EPSG = "EPSG:32628"

ORIGIN_EAST = 343000.0
ORIGIN_NORTH = 3130000.0

GRID_WIDTH = 2810
GRID_HEIGHT = 2298
RESOLUTION = 30.0
GRID_MIN_X = -34800.0
# Remember +Z is south: this is the *northern* edge, and it has to reach the
# Anaga tip at lat 28.61, which lands at z = -35273.
GRID_MIN_Z = -35400.0

# Geographic extent of interest, for choosing which source tiles to fetch.
BBOX_LON_MIN, BBOX_LON_MAX = -16.95, -16.10
BBOX_LAT_MIN, BBOX_LAT_MAX = 27.98, 28.61

MANIFEST_VERSION = 1

# Value written where the source raster has no data. Replaced with 0 on load,
# which is correct here because every gap in this bbox is open ocean.
NODATA = -9999.0


@dataclass(frozen=True)
class GridExtent:
    """The target grid expressed as UTM 28N edge coordinates."""

    west: float
    east: float
    south: float
    north: float

    @property
    def max_x(self) -> float:
        return GRID_MIN_X + (GRID_WIDTH - 1) * RESOLUTION

    @property
    def max_z(self) -> float:
        return GRID_MIN_Z + (GRID_HEIGHT - 1) * RESOLUTION


def grid_extent() -> GridExtent:
    """
    UTM 28N coordinates of the outermost *sample centres* of the target grid.

    Row 0 of the output is the northernmost row (minimum local z), matching the
    conventional north-up raster order — and matching how `Heightfield`
    indexes `samples`.
    """
    max_x = GRID_MIN_X + (GRID_WIDTH - 1) * RESOLUTION
    max_z = GRID_MIN_Z + (GRID_HEIGHT - 1) * RESOLUTION
    return GridExtent(
        west=ORIGIN_EAST + GRID_MIN_X,
        east=ORIGIN_EAST + max_x,
        # Local +Z is south, so local min_z is the *northern* edge.
        north=ORIGIN_NORTH - GRID_MIN_Z,
        south=ORIGIN_NORTH - max_z,
    )


def target_transform():
    """
    Affine transform for the target grid, positioned so that the centre of
    pixel (0, 0) lands exactly on the grid node (GRID_MIN_X, GRID_MIN_Z).

    Rasterio transforms address pixel *corners*, hence the half-pixel shift.
    Getting this wrong offsets the entire island by 15 m, which is invisible on
    a coastline but very visible when an OSM road fails to sit on its cutting.
    """
    from rasterio.transform import Affine

    ext = grid_extent()
    half = RESOLUTION / 2.0
    return Affine.translation(ext.west - half, ext.north + half) * Affine.scale(
        RESOLUTION, -RESOLUTION
    )


def manifest(min_elevation: float, max_elevation: float) -> dict:
    """Build the sidecar manifest consumed by `Heightfield.load()`."""
    return {
        "version": MANIFEST_VERSION,
        "width": GRID_WIDTH,
        "height": GRID_HEIGHT,
        "resolution": RESOLUTION,
        "originEast": ORIGIN_EAST,
        "originNorth": ORIGIN_NORTH,
        "bounds": {
            "minX": GRID_MIN_X,
            "maxX": GRID_MIN_X + (GRID_WIDTH - 1) * RESOLUTION,
            "minZ": GRID_MIN_Z,
            "maxZ": GRID_MIN_Z + (GRID_HEIGHT - 1) * RESOLUTION,
        },
        "minElevation": min_elevation,
        "maxElevation": max_elevation,
        "nodata": NODATA,
    }
