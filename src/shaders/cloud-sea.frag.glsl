/**
 * The mar de nubes — Tenerife's trade-wind cloud sea.
 *
 * The signature sight of the island: a dense stratocumulus deck sitting against
 * the north-facing slopes at roughly 800-1500 m, held down by the trade-wind
 * inversion, with Teide standing clear above it. It is why the north side is
 * green and the south is desert, and flying down into it is the best thing this
 * project can show.
 *
 * Implemented as a stack of horizontal alpha-blended slabs rather than a
 * raymarch. Flying *through* a stack of slabs gives a convincing volumetric
 * feeling for a tiny fraction of the cost, and — unlike a single plane — it does
 * not vanish the instant the camera crosses it.
 *
 * Three things make it read as this specific phenomenon rather than as generic
 * fog:
 *
 *   1. It is clipped against the terrain height, so it pools in valleys and laps
 *      up against slopes instead of intersecting them as a flat sheet.
 *   2. It is biased to the north side, because that is where the trade winds put
 *      it. A symmetric cloud layer looks like weather, not like Tenerife.
 *   3. Density falls off at the top and bottom of the deck, giving the inversion
 *      a defined ceiling — the flat top is the whole visual signature.
 *
 * Requires noise.glsl to be prepended.
 */

precision highp float;
precision highp sampler2D;

#include <common>
#include <logdepthbuf_pars_fragment>

uniform sampler2D uHeightmap;
uniform vec2 uGridMin;
uniform float uGridResolution;
uniform vec2 uGridSizeTexels;

uniform vec3 uSunDirection;
uniform vec3 uCloudColor;
uniform vec3 uCloudShadow;
uniform vec3 uFogColor;
uniform float uFogDensity;

/** Base and top of the deck, metres above sea level. */
uniform float uDeckBottom;
uniform float uDeckTop;
/** Overall opacity, 0 removes the cloud sea entirely. */
uniform float uCoverage;
/** Scrolls the deck with the trade wind. */
uniform vec2 uWind;

/** This slab's altitude, and its share of the total opacity. */
varying float vSlabHeight;
varying vec3 vWorldPos;

float sampleHeight(vec2 worldXZ) {
  vec2 texel = (worldXZ - uGridMin) / uGridResolution;
  vec2 uv = (texel + 0.5) / uGridSizeTexels;
  return texture2D(uHeightmap, uv).r;
}

void main() {
  #include <logdepthbuf_fragment>

  // Offset each slab's sample position by its altitude. Without this every slab
  // samples the same 2D field and the deck is a vertically extruded 2D pattern —
  // which reads as horizontal banding rather than as a volume. Decorrelating the
  // slabs is what turns a stack of sheets into something that looks like cloud.
  vec2 slabOffset = vec2(vSlabHeight * 3.7, vSlabHeight * -2.9);
  vec2 p = vWorldPos.xz + uWind + slabOffset;

  // Billowy shape. Two scales: broad cells for the overall structure of the
  // deck, finer detail for the edges where it breaks against the slopes.
  float broad = tnrf_fbm(p * 0.00042, 4, 2.05, 0.55);
  float fine = tnrf_fbm(p * 0.0021, 3, 2.1, 0.5);
  // fbm is signed, roughly [-0.6, 0.6] in practice. Remap to 0..1 before
  // thresholding — treating the signed value as coverage discards most of the
  // field and leaves scattered blobs rather than a stratocumulus deck.
  float density = smoothstep(-0.26, 0.24, broad * 0.72 + fine * 0.28);

  // Vertical profile: densest in the middle of the deck, thinning to nothing at
  // the inversion ceiling. The sharp top edge is the defining feature.
  float mid = (uDeckBottom + uDeckTop) * 0.5;
  float halfSpan = (uDeckTop - uDeckBottom) * 0.5;
  float vertical = 1.0 - clamp(abs(vSlabHeight - mid) / halfSpan, 0.0, 1.0);
  // Asymmetric: the top is abrupt (the inversion), the base is diffuse.
  vertical *= vSlabHeight > mid ? 0.82 : 1.0;

  // North bias. -Z is north in the island-local frame, so cloud builds up as z
  // decreases. The noise term keeps the boundary from being a straight line.
  //
  // Written as 1 - smoothstep(lo, hi, ...) rather than smoothstep(hi, lo, ...):
  // GLSL leaves smoothstep undefined when edge0 >= edge1, and the reversed form
  // silently produced garbage on this driver.
  float north = 1.0 - smoothstep(-6000.0, 9000.0, vWorldPos.z + broad * 5200.0);

  // Clip against the terrain. Where the ground rises above this slab there can
  // be no cloud, and the soft edge is what makes the deck lap against the slope
  // rather than slice through it.
  float ground = sampleHeight(vWorldPos.xz);
  float aboveGround = smoothstep(-40.0, 90.0, vSlabHeight - ground);

  // Thicken where the deck meets rising ground. This is the defining behaviour
  // of the mar de nubes: the inversion traps it against the north slopes, so it
  // banks up and pools there rather than lying flat at uniform density.
  float slopeHug = 1.0 + 0.85 * (1.0 - smoothstep(0.0, 700.0, vSlabHeight - ground));

  // Per-slab opacity. Fourteen slabs at this value composite to effectively
  // opaque through the middle of the deck, which is correct — you should not see
  // the coast through it — while the vertical profile keeps the edges soft.
  float alpha = density * 0.34 * slopeHug;
  alpha *= vertical * north * aboveGround * uCoverage;
  alpha = clamp(alpha, 0.0, 1.0);

  // Soft fade for slabs close to the camera.
  //
  // Two problems this solves. Crossing a slab plane otherwise flashes, because
  // an alpha-blended quad goes from fully present to fully behind you in one
  // frame. And sitting inside the deck stacks every slab above and below across
  // the whole frame, which blanks the screen to flat white — physically defensible
  // but useless to look at, and it happens on the descent through the inversion.
  float camFade = smoothstep(0.0, 110.0, abs(vSlabHeight - cameraPosition.y));
  alpha *= mix(0.12, 1.0, camFade);

  if (alpha < 0.004) discard;

  // Shade from the top: sunlit crowns, shadowed undersides. Cheap stand-in for
  // scattering, using how far up the deck this slab sits.
  float lit = clamp((vSlabHeight - uDeckBottom) / max(uDeckTop - uDeckBottom, 1.0), 0.0, 1.0);
  lit = mix(lit, 1.0, max(uSunDirection.y, 0.0) * 0.35);
  vec3 color = mix(uCloudShadow, uCloudColor, lit);

  // Same aerial perspective as everything else, so the deck recedes with the
  // terrain it sits on instead of staying uniformly bright to the horizon.
  float dist = length(vWorldPos - cameraPosition);
  float haze = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  color = mix(color, uFogColor, haze);

  gl_FragColor = vec4(color, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
