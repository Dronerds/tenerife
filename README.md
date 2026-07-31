# tenerife

A low-altitude terrain proof of concept over the island of Tenerife, in
TypeScript / three.js / Vite.

This is **not** the simulator — it is a standalone experiment answering one
question: *can a real island be made to look convincing from 10–20 m above the
ground, using open data plus procedural synthesis?*

## The idea

The drone flies at 10–20 m AGL. The elevation data is posted every 30 m. At that
altitude a single terrain quad fills half the screen, so the terrain data cannot
supply what the eye sees. The architecture follows from resolving that:

| Layer | Role |
| --- | --- |
| DEM (30 m) | the low-frequency envelope — the true shape of the island |
| Procedural | everything within 30 m: surface roughness, rock, scrub, ground texture |
| OpenStreetMap | the man-made truth — roads, tracks, buildings, walls |

Realism at 15 m therefore comes almost entirely from the procedural and OSM
layers. The DEM being 30 m is not the limiting factor.

## Status

All nine milestones are implemented.

| | Milestone | |
| --- | --- | --- |
| ✅ | **M0** Scaffold | Vite + TypeScript + three.js |
| ✅ | **M1** Heightfield | FABDEM pipeline, resident heightfield, CPU queries |
| ✅ | **M2** CDLOD terrain | whole island, seamless LOD |
| ✅ | **M3** Imagery + land cover | ESA WorldCover biomes, Sentinel-2 median composite |
| ✅ | **M4** Procedural surface | noise displacement, biome ground materials |
| ✅ | **M5** Vegetation | instanced scatter by altitudinal band |
| ✅ | **M6** OSM | 113,812 buildings, 52,309 roads, 14,615 waterways, 5,429 water bodies, 30,978 land-use polygons |
| ✅ | **M7** Drone | FPV camera flying the Punta Brava → Teide route |
| ✅ | **M8** Atmosphere | sky dome, aerial perspective, the *mar de nubes* |

### Known limitations

- **Roads are not cut into the terrain.** They sit on the bare DEM plus 0.55 m,
  so on rough ground (pine, lava — up to ~3 m of procedural displacement) terrain
  detail can clip through a road. The fix is a rasterised road mask that
  suppresses displacement along corridors; not built.
- **Vegetation is crossed billboards plus a horizontal canopy quad**, not modelled
  plants. The canopy quad is what makes them work from ~50 m; fly into a stand and
  they are still visibly flat.
- **Buildings are deliberately abstract** — flat extruded prisms coloured by a
  height ramp, in the style of a Mapbox `fill-extrusion` layer. An earlier version
  had generated facade textures with windows and balconies; it looked worse,
  because surface detail on an untextured prism with no window recesses or street
  furniture invites a comparison with reality that the geometry cannot survive.
  Footprints come from OSM, so coverage is as good or bad as OSM's is locally.
- **`prepare_osm.py` handles OSM ways only, not relations.** Buildings, water
  bodies and land-use areas mapped as multipolygons are missing entirely. Not yet
  measured.
- **No shadows.** Direct sun plus hemispheric fill only; nothing casts.
- Imagery is a 30 m resample of 10 m source, deliberately — it is for the mid and
  far field, and the near field is procedural.

## Running it

```bash
npm install

python3 -m venv tools/.venv
tools/.venv/bin/pip install rasterio numpy osmium pillow

# All four data steps. Each caches its downloads and skips if already built.
tools/.venv/bin/python tools/prepare_heights.py      # FABDEM      -> 26 MB
# OSM must run before landcover: its land-use polygons are burned over WorldCover.
tools/.venv/bin/python tools/prepare_osm.py          # OSM         -> 48 MB
tools/.venv/bin/python tools/prepare_landcover.py    # WorldCover  -> 6.5 MB
tools/.venv/bin/python tools/prepare_imagery.py      # Sentinel-2  -> 8.8 MB (slow)

npm run dev
```

Only `prepare_heights.py` is required. Land cover, OSM and imagery each degrade
gracefully if absent — biomes fall back to elevation rules, and the ground falls
back to procedural colour at all distances.

It starts in FPV, flying the route at ~50 m AGL.

| key | |
| --- | --- |
| `V` | FPV flight / free orbit |
| `space` | pause |
| `[` `]` | slower / faster |
| `,` `.` | previous / next waypoint |
| `1`-`4` | materials, quadtree depth, morph factor, biome |
| `D` | toggle procedural surface detail |
| `G` | toggle vegetation |
| `B` | toggle buildings and roads |
| `C` | cloud sea: clear / partial / full |
| `I` | toggle satellite imagery |

The toggles exist because the honest way to judge what a layer contributes is to
turn it off.

## The demo route

Punta Brava → Puerto de la Cruz → La Orotava → up the valley to the Las Cañadas
plateau → east to the Teide Observatory at Izaña → Pico del Teide → a circuit of
the cone → back down the north slope to Puerto de la Cruz. ~68 km, 26 waypoints,
cruising at ~50 m AGL.

It climbs from sea level to 3,715 m and so crosses every one of Tenerife's
vegetation bands in order — coastal euphorbia scrub, the cultivated terraces of
the Orotava valley, laurisilva on the wet north slope, Canary pine, retama, bare
lava — and back down. That makes it the test case for everything else: each
milestone gets judged by flying it, not by static screenshots. It also climbs
through the altitude of the *mar de nubes* on the north face, which is what M8 is
for.

Waypoint elevations check out against reality: La Orotava 394 m (true ~390),
Aguamansa 1204 m in pine (true ~1100), El Portillo 2118 m (true ~2050), Izaña
2430 m (true 2390).

## Key decisions

**Heights are resident, never streamed.** The island at 30 m is 2810 × 2298 =
6.5 M samples — ~26 MB as Float32. It is loaded once and kept, both as a
`Float32Array` for CPU queries and as an `R32F` texture sampled in the terrain
vertex shader. This removes the entire height-streaming subsystem: no tile cache,
no async fetch during flight, no LOD seam from a missing neighbour, no pop-in.
Only imagery, vegetation and OSM geometry will stream.

**CDLOD quadtree, one draw call.** A node is emitted once the camera is beyond
2.5 node-widths away, so every node subtends roughly the same angle and triangle
density stays near-constant from 15 m AGL out to the horizon. Nodes morph into
their parent's geometry before the swap, so transitions do not pop. All visible
nodes render as instances of one shared 65 × 65 grid.

**Island-local metres.** UTM 28N (EPSG:32628) shifted to an origin near the
island centre, 1 unit = 1 m, +Y up, **+Z south**. Raw UTM northings are ~3.13e6,
where float32 resolves to only ~0.25 m — enough to produce visible vertex jitter
at low altitude. See [`src/geo/origin.ts`](src/geo/origin.ts).

**Determinism, once procedural detail lands.** All synthesis must be
position-seeded integer-hash noise — never `Math.random()`, never per-frame or
per-session state, never dependent on LOD level or tile. And because the vertex
shader will displace the surface away from the raw heightfield that the drone
collides against, the noise function becomes a shared CPU/GPU contract with a
parity test. Both are cheap now and structural later.

## Data

| Layer | Source | Licence |
| --- | --- | --- |
| Heights | FABDEM v1.2 (default) | **CC BY-NC-SA 4.0 — non-commercial** |
| Heights | Copernicus GLO-30 DSM (`--source copernicus`) | free, open |
| Land cover | ESA WorldCover 10 m v200 (2021), overlaid with OSM land use | CC BY 4.0 / ODbL |
| Imagery | Sentinel-2 L2A, 8-scene median composite | free, open (Copernicus) |
| Vectors | OpenStreetMap via Geofabrik Canary Islands | ODbL |

FABDEM is Copernicus GLO-30 with forests and buildings machine-removed. Bare
earth is what we want, since we synthesise our own vegetation and extrude our own
buildings — on a surface model we would be planting trees on top of tree-shaped
bumps. The official distribution is behind a click-through licence, but the full
v1.2 tile set is mirrored ungated on Hugging Face, so it downloads unattended.

Confirmation it really is bare earth, sampling both sources at the same points:

| point | FABDEM | GLO-30 | diff |
| --- | --- | --- | --- |
| Anaga laurisilva | 939.9 | 954.9 | +15.0 |
| Orotava forest | 1170.2 | 1174.9 | +4.6 |
| Teide summit | 3699.5 | 3698.6 | −0.9 |
| Las Cañadas lava floor | 2171.7 | 2171.9 | +0.2 |

15 m of canopy removed under Anaga's laurisilva (real laurisilva is 15–20 m tall)
and essentially nothing on bare rock — which is exactly the expected signature.

Evidence the coordinate chain is right: the pipeline resolves Teide at **3703 m**
against a true 3715 m, within half a DEM cell for a sharp cone. `test/geo.test.ts`
pins that along with coastline coverage and axis orientation.

## Layout

```
tools/            Python data prep, headless capture, noise-parity check
src/geo/          projection, island-local origin, resident heightfield
src/terrain/      CDLOD quadtree, instanced chunk geometry, renderer
src/shaders/      terrain GLSL + the canonical noise and surface definitions
src/procedural/   CPU mirrors of the shader noise, baked detail texture
src/vegetation/   species table, scatter, generated foliage silhouettes
src/osm/          roads, buildings and walls as merged geometry
src/drone/        the demo route and the FPV camera
src/sky/          sky dome, sea, haze, and the mar de nubes
test/             coordinate and heightfield contract tests
```

### Two things worth knowing before editing

**The noise contract.** `src/shaders/noise.glsl` + `surface.glsl` and
`src/procedural/noise.ts` + `surface.ts` are two implementations of the same
functions. Change one, change both, and run `npm run verify:noise`. They exist in
duplicate because the terrain vertex shader displaces the ground while the drone
collides against the CPU copy; the integer hash is bit-exact by design so that
this is checkable at all.

**Where noise may be evaluated.** Analytic noise runs in the *vertex* stage only
(~1 M vertices, and parity is required there). The *fragment* stage samples the
baked `detail-texture.ts` instead. Evaluating the analytic noise per pixel is
~160 integer hashes per fragment and measured at 17 fps; the baked texture is two
fetches and runs at 60.

**OSM land use beats the satellite classification, and is burned over it.**
WorldCover is a 10 m classifier; OSM is surveyed. OSM wins on boundaries and knows
what a classifier cannot — that a stand of trees is an *orchard*. This matters
concretely: WorldCover labels 0.22% of the grid as cropland because Tenerife's
banana terraces sit under plastic and netting, and after the OSM overlay cropland
is **6.24% of land area**. See `burn_osm` in prepare_landcover.py.

**Categorical data must never be interpolated.** Land-cover classes and biome ids
are ids, not quantities. Averaging class 10 with class 50 yields class 30 —
inventing a category nobody observed. Hence `NearestFilter` on the cover texture,
and hence biome being classified per *fragment* rather than passed down as a
varying: interpolating between biome 4 and 6 produces 5, painting a band of the
wrong material along every boundary between non-adjacent biomes.

## Verification

```bash
npm run typecheck
npm test                # coordinate chain, Teide elevation, axis orientation
npm run dev &
npm run verify:noise    # GPU readback vs CPU noise, exits non-zero on divergence
npm run capture         # headless Chrome, real GPU, fixed viewpoints
```

Both harnesses drive real Chrome against a real GPU and exit non-zero on any page
error, so a shader that fails to link is a build failure rather than a black
screen someone notices later.

`npm run verify:noise` renders the GLSL noise to a float target, reads it back,
and compares against the TypeScript. The hash agrees exactly; the float
tolerance is derived from the peak detail amplitude so a pass bounds CPU/GPU
terrain disagreement to under 8 mm, against the drone's 8 m ground clearance.
