# tenerife — the Cesium branch

Tenerife on CesiumJS instead of three.js.

This branch is **not meant to be merged**. It exists to be run beside `main` and
compared: same island, same six capture viewpoints, a completely different
answer to where the world comes from.

|                | `main`                                    | `cesium`                                     |
| -------------- | ----------------------------------------- | -------------------------------------------- |
| Renderer       | three.js, hand-built                      | CesiumJS                                     |
| Terrain        | FABDEM 30 m, resident, CDLOD quadtree     | Cesium World Terrain, streamed               |
| Surface detail | procedural noise displacement             | none — what the tiles give                   |
| Ground colour  | biome materials + Sentinel-2 composite    | Google photogrammetry                        |
| Buildings      | OSM ways extruded locally, 48 MB osm.json | Google photogrammetry (OSM Buildings on `P`) |
| Vegetation     | instanced billboards by altitude band     | none                                         |
| Sky            | hand-written dome, haze, _mar de nubes_   | Cesium atmosphere                            |
| Local data     | ~90 MB, four Python prep scripts          | none                                         |
| Source         | ~7,400 lines TS/GLSL + 1,160 Python       | ~900 lines TS                                |

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

**The app opens on Google Photorealistic 3D Tiles, which are metered.** Billing
is per _session_, not per tile: one root tileset request covers up to three hours
of tile requests, so a visit costs one unit however long it lasts. The ion free
tier allows 1,000 of those a month and has no payment path — at the cap it stops
serving tiles rather than billing you. Press `P` to fall back to Cesium World
Terrain plus Cesium OSM Buildings, which are free on the ion free tier and are
also the like-for-like comparison against the three.js version.

If the tiles cannot be had at all — quota gone, token revoked — the app falls
back to that same free stack on its own and says so in the HUD, rather than
failing to load.

Google licence these tiles for use only with the Google geocoder; this app has
no geocoder at all, so the restriction holds trivially. Their attribution
appears in the credit container, which is why that container is not disabled.

## Controls

| key |                                                |
| --- | ---------------------------------------------- |
| `B` | toggle buildings                               |
| `P` | photorealistic tiles / terrain + OSM buildings |

## The view

Opens over Punta Brava at 91 m, heading 117° — east-southeast, low along the
seafront terraces. From there the camera is yours: it is Cesium's own screen-space controller, so
left-drag pans, scroll or right-drag zooms, and ctrl-drag (or middle-drag)
rotates and tilts.

A loading screen holds until the tiles are in. Photogrammetry streams
coarsest-first, and its root tiles are enormous smeared blobs that read as a
broken mesh for the several seconds they take to refine — the overlay covers
that rather than showing it.

Nothing moves the camera on its own. The 26-waypoint route flight the three.js
version flies is not carried over here.

Camera collision detection is off, so you can zoom all the way down to street
level — and, equally, straight through the ground.

## What Cesium gave, and what it took

**Gave.** Global streaming LOD, a real WGS84 ellipsoid with real sun and time,
textured photogrammetry as the default surface, and the deletion of the entire
local data pipeline. It also runs faster: 47–61 fps across the six capture
viewpoints on photorealistic tiles, against 25–36 for the three.js version on
the same machine.

**Took.** All of the procedural work. The noise-displaced surface and its
CPU/GPU parity contract, the biome-aware ground materials, and the altitudinal
vegetation scatter are gone, because Cesium offers no vertex-displacement hook
on its globe — you can override the globe's _material_, but not push its terrain
around. So does the _mar de nubes_: Cesium has no stratus-deck primitive, and
`CloudCollection` is cumulus billboards, not an inversion layer.

**A wash.** Cesium World Terrain is ~30 m, the same as FABDEM, so swapping
terrain providers changes very little on its own. What changes the image is the
photorealistic tiles. That holds up while you stay a few hundred metres up; zoom
right down to the 15 m this project originally targeted and the photogrammetry
looks melted.

## Layout

```
src/geo/          local ENU frame over the island
src/layers.ts     which layers show, and the photoreal fallback
tools/            Cesium asset staging, headless capture
test/             frame and layer contract tests
```

## Verification

```bash
npm run typecheck
npm test                # ENU round-trip, axis orientation
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

## Deployment

Pushing a `v*` tag builds the site and deploys it to Firebase Hosting at
<https://puerto.dronerds.io>. The release workflow's `deploy` job is the only
thing that publishes; nothing deploys from a branch or a pull request.

The deployed build is **not** the tarball attached to the GitHub Release. Vite
inlines `VITE_*` at build time, so the tarball is built without a token — it
would otherwise ship a credential inside a public download with no way to
rotate it. The deploy job builds a second time with the token, and asserts it
landed in the bundle rather than publishing a site that errors for every
visitor.

### One-time setup

Repository secrets (Settings → Secrets and variables → Actions):

| Secret                     | What                                                    |
| -------------------------- | ------------------------------------------------------- |
| `VITE_CESIUM_ION_TOKEN`    | the same token as `.env.local`                          |
| `FIREBASE_SERVICE_ACCOUNT` | JSON key; `npx firebase init hosting:github` creates it |

Firebase, once:

```bash
npx firebase login
npx firebase hosting:sites:create puerto-dronerds   # must match "site" in firebase.json
```

The project ID is `dronerds`, set in `release.yml`; the site ID lives in
`firebase.json` so the mapping is in git rather than in someone's `.firebaserc`.
Spark (free) is sufficient — custom domains and multiple sites are both included
and no card is needed.

DNS at one.com: add the TXT record the Firebase console gives you for the
`puerto` host and verify, then the A record to the IP the console shows.
Firebase uses A records for subdomains, not CNAME. Remove any AAAA record for
that host. SSL provisions itself, usually within hours.

Scope the ion token in the ion dashboard to this domain and to the assets used
here. It is readable by anyone who loads the site — that is inherent to a
browser app talking to ion, and scoping is the mitigation, not secrecy.

### Adding another subdomain

Append an entry to the `hosting` array in `firebase.json` with its own `site`,
create the site, add the DNS records. The ceilings are 20 subdomains per apex
(an SSL minting limit) and 36 sites per Firebase project.

### What it costs

Nothing, at the traffic this will see. Photorealistic tiles bill per _session_ —
one root tileset request covers up to three hours — so a visit costs one unit no
matter how long it lasts. The ion free tier allows 1,000 sessions a month, which
is about 32 visitors a day, and Firebase's free transfer allowance runs out at
roughly the same point. There is no payment method attached: at the cap it stops
serving tiles rather than billing.

When that happens the site does not go down. `src/layers.ts` falls back to
terrain plus OSM buildings and says so in the HUD.

## Not carried over

Deleted rather than ported, and not coming back on this branch: the CDLOD
quadtree and terrain shaders, the procedural noise and its parity test
(`verify:noise` is gone, since there is no shader and no CPU mirror to disagree),
the baked detail texture, vegetation, the sky dome, sea plane and cloud sea, the
OSM extrusion layer, the resident heightfield, land cover, the Sentinel-2
imagery composite, the UTM-local frame and hand-rolled Transverse Mercator, and
the four Python prep scripts with the `data` npm script that drove them.

## Data

| Layer                          | Source                                 | Licence                   |
| ------------------------------ | -------------------------------------- | ------------------------- |
| Terrain                        | Cesium World Terrain via ion           | ion terms                 |
| Imagery                        | ion default imagery                    | ion terms                 |
| Buildings                      | Cesium OSM Buildings (ion asset 96188) | ODbL                      |
| Photorealistic tiles (default) | Google Photorealistic 3D Tiles         | Google terms, **metered** |
