/**
 * CDLOD terrain vertex shader.
 *
 * One instanced draw call renders every visible quadtree node. The base
 * geometry is a flat unit grid in [0,1]^2; per-instance attributes place and
 * scale it, and elevation is fetched from the resident island heightmap.
 *
 * The morph is what makes LOD transitions invisible. As a node approaches the
 * distance where its parent takes over, its odd-indexed vertices slide onto the
 * even-indexed positions its parent would use. By the time the swap happens the
 * two meshes are geometrically identical, so there is nothing to pop.
 *
 * Requires noise.glsl and surface.glsl to be prepended (see terrain.ts).
 */

precision highp float;
precision highp sampler2D;

// The renderer uses a logarithmic depth buffer, because a single frame spans
// metres to tens of kilometres. Built-in materials get this injected for them;
// a custom ShaderMaterial must opt in explicitly, and a shader that forgets
// writes depth in a different space from everything that did remember —
// producing a scene where the sea plane occludes the entire island.
#include <common>
#include <logdepthbuf_pars_vertex>
// Shadow receiving. `worldpos_vertex` needs `transformed` and `objectNormal`
// defined, so those are declared just before the include below.
#include <shadowmap_pars_vertex>

/** Single-channel float texture of the whole island, metres above sea level. */
uniform sampler2D uHeightmap;
/** Compacted WorldCover class per sample, nearest-filtered. */
uniform sampler2D uLandCover;
/** Local-space position of heightmap sample (0,0). */
uniform vec2 uGridMin;
/** Metres between heightmap samples. */
uniform float uGridResolution;
/** Heightmap dimensions in samples. */
uniform vec2 uGridSizeTexels;
/** Camera position in local metres — drives the morph, and must match the
 *  camera used for node selection or nodes morph against the wrong distance. */
uniform vec3 uCameraPos;
/** Quads per node edge. */
uniform float uMeshDim;
/** Finest quadtree depth. Only this level carries procedural detail. */
uniform float uMaxDepth;
/** Global scale on procedural displacement; 0 disables it entirely. */
uniform float uDetailScale;

/** Node minimum corner in local metres. */
attribute vec2 aOffset;
/** Node edge length in metres. */
attribute float aScale;
/** Camera distances between which this node morphs into its parent. */
attribute vec2 aMorphRange;
/** Quadtree depth, for debug shading and detail gating. */
attribute float aDepth;

varying vec3 vWorldPos;
varying float vDepth;
varying float vMorphK;
varying float vSlope;
varying float vDetail;

/**
 * Elevation at a local-space XZ position.
 *
 * The half-texel offset matters: heightmap samples are *points* on the grid,
 * not cell averages, so sample i sits at texture coordinate (i + 0.5) / width.
 * Omitting it shifts the whole island by half a cell.
 */
float sampleHeight(vec2 worldXZ) {
  vec2 texel = (worldXZ - uGridMin) / uGridResolution;
  vec2 uv = (texel + 0.5) / uGridSizeTexels;
  return texture2D(uHeightmap, uv).r;
}

/**
 * Observed land-cover class at a position.
 *
 * The texture is nearest-filtered and the value is rounded back to an integer:
 * these are categorical ids, and any interpolation between them invents classes
 * that were never observed.
 */
int sampleCover(vec2 worldXZ) {
  vec2 texel = (worldXZ - uGridMin) / uGridResolution;
  vec2 uv = (texel + 0.5) / uGridSizeTexels;
  return int(texture2D(uLandCover, uv).r * 255.0 + 0.5);
}

/** Normal of the bare heightfield, by central differences. */
vec3 baseNormal(vec2 worldXZ) {
  float e = uGridResolution;
  float hL = sampleHeight(worldXZ - vec2(e, 0.0));
  float hR = sampleHeight(worldXZ + vec2(e, 0.0));
  float hD = sampleHeight(worldXZ - vec2(0.0, e));
  float hU = sampleHeight(worldXZ + vec2(0.0, e));
  return normalize(vec3(hL - hR, 2.0 * e, hD - hU));
}

void main() {
  // The base grid arrives as XZ in [0,1] with Y unused.
  vec2 gridPos = position.xz;

  vec2 worldXZ = aOffset + gridPos * aScale;
  float height = sampleHeight(worldXZ);

  float dist = distance(uCameraPos, vec3(worldXZ.x, height, worldXZ.y));
  float morphK = clamp(
    (dist - aMorphRange.x) / max(aMorphRange.y - aMorphRange.x, 1e-4),
    0.0,
    1.0
  );

  // Snap odd vertices back onto the parent's even grid, proportionally to
  // morphK. fract() is 0 at even indices and 0.5 at odd ones.
  vec2 fracPart = fract(gridPos * uMeshDim * 0.5) * 2.0 / uMeshDim;
  vec2 morphedGrid = gridPos - fracPart * morphK;

  worldXZ = aOffset + morphedGrid * aScale;
  height = sampleHeight(worldXZ);

  vec3 normal = baseNormal(worldXZ);
  float slope = 1.0 - normal.y;
  int biome = tnrf_biome(worldXZ, height, slope, tnrf_wetness(normal), sampleCover(worldXZ));

  // Procedural displacement, and the subtle part of this shader.
  //
  // Detail is applied ONLY on the finest level, faded out by that level's own
  // morph factor. That is what keeps it LOD-stable: as a finest-level node
  // dissolves into its parent, morphK goes to 1 and the detail goes to 0, so at
  // the instant of the swap both meshes agree exactly — the parent carries no
  // detail either. Fading by camera distance instead would make the surface
  // swim as the camera moves, and gating by level without the morph fade would
  // crack at every LOD boundary.
  //
  // The consequence is that detail exists only within the finest level's
  // selection range (~210 m). That is fine at 15 m AGL: 1-3 m bumps are not
  // resolvable further out. It also means the drone, which is always at the
  // centre of that range, sees full-amplitude detail — so the CPU mirror in
  // surface.ts only has to match the un-faded case.
  float finest = step(uMaxDepth - 0.5, aDepth);
  float detailAmount = finest * (1.0 - morphK) * uDetailScale;
  float detail = detailAmount > 0.0
    ? tnrf_detail(worldXZ, biome, slope) * detailAmount
    : 0.0;
  height += detail;

  vec3 worldPos = vec3(worldXZ.x, height, worldXZ.y);
  vWorldPos = worldPos;
  vDepth = aDepth;
  vMorphK = morphK;
  vSlope = slope;
  vDetail = detail;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);

  // three's shadow chunks read these exact names. `transformedNormal` must be in
  // *view* space: the chunk converts it back to world with
  // inverseTransformDirection(..., viewMatrix) to offset the shadow lookup along
  // the surface normal.
  vec4 worldPosition = vec4(worldPos, 1.0);
  vec3 transformedNormal = normalMatrix * normal;
  #include <shadowmap_vertex>

  #include <logdepthbuf_vertex>
}
