# tenerife — the Cesium branch

The same demo flight over Tenerife, rebuilt on CesiumJS instead of three.js.

This branch is **not meant to be merged**. It exists to be run beside `main` and
compared: same island, same 26 waypoints, same six capture viewpoints, a
completely different answer to where the world comes from.

| | `main` | `cesium` |
| --- | --- | --- |
| Renderer | three.js, hand-built | CesiumJS |
| Terrain | FABDEM 30 m, resident, CDLOD quadtree | Cesium World Terrain, streamed |
| Surface detail | procedural noise displacement | none — what the tiles give |
| Ground colour | biome materials + Sentinel-2 composite | Google photogrammetry |
| Buildings | OSM ways extruded locally, 48 MB osm.json | Google photogrammetry (OSM Buildings on `P`) |
| Vegetation | instanced billboards by altitude band | none |
| Sky | hand-written dome, haze, *mar de nubes* | Cesium atmosphere |
| Local data | ~90 MB, four Python prep scripts | none |
| Source | ~7,400 lines TS/GLSL + 1,160 Python | ~900 lines TS |

## Running both at once

```bash
# from the main checkout, once
git branch cesium
git worktree add ../tenerife-cesium cesium

cd ../tenerife-cesium
npm install                       # postinstall stages Cesium's runtime assets
cp .env.example .env.local        # then paste an ion token into it
npm run dev                       # 5174
```

`main` keeps port 5173 and `cesium` takes 5174, so both dev servers run
together and you can flip between two browser tabs.

Worktrees do not share `node_modules`, and this branch never needs
`public/data/` — don't copy it across.

### The ion token

Get one from [ion.cesium.com/tokens](https://ion.cesium.com/tokens) and put it in
`.env.local` as `VITE_CESIUM_ION_TOKEN`. Startup fails with a message in the HUD
if it is missing.

**It is not a secret.** Vite inlines `VITE_`-prefixed variables into the built
bundle, so anyone who loads the app can read it. That is inherent to a
browser-side ion client. The mitigation is to scope the token in the ion
dashboard — to the specific assets this app uses, and to allowed URLs — not to
imagine that `.env` hides it.

### What costs money

**The app opens on Google Photorealistic 3D Tiles, which are metered.** Google
bills per tile request through the ion quota, so simply running this costs
something — there is no free-by-default mode. Press `P` to fall back to Cesium
World Terrain plus Cesium OSM Buildings, which are free on the ion free tier and
are also the like-for-like comparison against the three.js version.

Google licence these tiles for use only with the Google geocoder; this app has
no geocoder at all, so the restriction holds trivially. Their attribution
appears in the credit container, which is why that container is not disabled.

## Controls

| key | |
| --- | --- |
| `V` | FPV flight / free orbit |
| `space` | pause |
| `[` `]` | slower / faster |
| `,` `.` | previous / next waypoint |
| `B` | toggle buildings |
| `P` | photorealistic tiles / terrain + OSM buildings |

## The demo route

Punta Brava → Puerto de la Cruz → La Orotava → up the valley to the Las Cañadas
plateau → east to the Teide Observatory at Izaña → Pico del Teide → a circuit of
the cone → back down the north slope to Puerto de la Cruz. 26 waypoints,
cruising at ~100 m AGL.

It climbs from sea level to 3,715 m and so crosses every one of Tenerife's
vegetation bands in order — coastal euphorbia scrub, the cultivated terraces of
the Orotava valley, laurisilva on the wet north slope, Canary pine, retama, bare
lava — and back down.

The waypoints are carried over from `main` byte for byte. On Cesium World
Terrain the route measures 67.9 km and Teide resolves to 3,728 m against a true
3,715 m.

## What Cesium gave, and what it took

**Gave.** Global streaming LOD, a real WGS84 ellipsoid with real sun and time,
textured photogrammetry as the default surface, and the deletion of the entire
local data pipeline. It also runs faster: 47–61 fps across the six capture
viewpoints on photorealistic tiles, against 25–36 for the three.js version on
the same machine.

**Took.** All of the procedural work. The noise-displaced surface and its
CPU/GPU parity contract, the biome-aware ground materials, and the altitudinal
vegetation scatter are gone, because Cesium offers no vertex-displacement hook
on its globe — you can override the globe's *material*, but not push its terrain
around. So does the *mar de nubes*: Cesium has no stratus-deck primitive, and
`CloudCollection` is cumulus billboards, not an inversion layer. The waypoint
still named "Above the cloud sea" is now just a high waypoint.

**A wash.** Cesium World Terrain is ~30 m, the same as FABDEM, so swapping
terrain providers changes very little on its own. What changes the image is the
photorealistic tiles. At this route's ~100 m cruise that is a fair trade; it
would be a worse one at the 15 m this project originally targeted, where
photogrammetry looks melted.

## Two things worth knowing before editing

**The spline is a hand-port of three.js's, not Cesium's.** Cesium ships
`CatmullRomSpline`, and feeding it centripetal knot times looks equivalent. It
is not: Cesium builds each cubic on the interval between knots, so the spacing
changes the curve's *shape*, while three.js uses the spacing only to estimate
tangents and then rescales them onto a unit interval. The Cesium version wandered
up to 167 m horizontally and 177 m vertically from the three.js path — different
valleys at the tight turns. With the port the two agree to 6.7 m over 68 km, and
that residual is UTM scale distortion in `main`'s frame, not the curve. See
[`src/drone/spline.ts`](src/drone/spline.ts).

**Ground is sampled once, not per frame.** Cesium's height query is async and
returns nothing for tiles that are not loaded, so a per-frame query fails exactly
where the drone has just flown somewhere new. Instead the terrain under the route
is resolved at startup — the 26 waypoints, then the spline at 25 m spacing, about
2,700 samples in ~1 s — and baked into a profile indexed by distance travelled.
The clearance clamp is then a synchronous lookup. See
[`src/drone/terrain-profile.ts`](src/drone/terrain-profile.ts).

Note that this samples the *globe* terrain, not the photorealistic tileset drawn
over it, so the visible surface can stand above the terrain the clearance was
measured against. Measured along the whole route with `scene.clampToHeight`, the
worst case is **24.4 m of clearance** above the photogrammetry, at the Pine
forest climb — the same place the globe-terrain minimum falls. Nothing clips,
but the margin is about 6 m tighter than the nominal 32 m, so lowering
`MIN_CLEARANCE` would need re-measuring rather than reasoning.

## Layout

```
src/geo/          local ENU frame over the island
src/drone/        the demo route, the centripetal spline, the terrain profile, the FPV camera
tools/            Cesium asset staging, headless capture
test/             frame and route contract tests
```

## Verification

```bash
npm run typecheck
npm test                # ENU round-trip, axis orientation, route length and clamps
npm run dev &
npm run capture         # headless Chrome, real GPU, six fixed viewpoints
```

The scene clock is pinned to a fixed instant so lighting is reproducible.
Without that, `enableLighting` shades from the real sun at the wall clock and
every capture comes out differently — or in darkness.

The comparison this branch exists for:

```bash
(cd ../tenerife        && npm run dev &)   # 5173
(cd ../tenerife-cesium && npm run dev &)   # 5174
(cd ../tenerife        && npm run capture captures-three)
(cd ../tenerife-cesium && npm run capture captures-cesium)
```

Then open the same filename from each directory side by side. Captures shoot
the photorealistic tiles, since that is what the app opens on; `BASELINE=1
npm run capture` shoots terrain plus OSM buildings instead, which is the fairer
comparison against `main` and costs nothing.

## Not carried over

Deleted rather than ported, and not coming back on this branch: the CDLOD
quadtree and terrain shaders, the procedural noise and its parity test
(`verify:noise` is gone, since there is no shader and no CPU mirror to disagree),
the baked detail texture, vegetation, the sky dome, sea plane and cloud sea, the
OSM extrusion layer, the resident heightfield, land cover, the Sentinel-2
imagery composite, the UTM-local frame and hand-rolled Transverse Mercator, and
the four Python prep scripts with the `data` npm script that drove them.

## Data

| Layer | Source | Licence |
| --- | --- | --- |
| Terrain | Cesium World Terrain via ion | ion terms |
| Imagery | ion default imagery | ion terms |
| Buildings | Cesium OSM Buildings (ion asset 96188) | ODbL |
| Photorealistic tiles (default) | Google Photorealistic 3D Tiles | Google terms, **metered** |
