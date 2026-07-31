/**
 * Sky dome.
 *
 * Not a full Rayleigh/Mie integration — a fitted gradient with a sun disc and
 * forward-scattering glow, which at the altitudes this project cares about is
 * indistinguishable from the real thing and costs a fraction as much.
 *
 * The one physical behaviour that genuinely matters here is that the horizon
 * stays bright and desaturated while the zenith goes deep blue, because the
 * whole island is viewed against the horizon band. A naive vertical lerp puts a
 * visible flat ceiling above Teide.
 */

precision highp float;

uniform vec3 uSunDirection;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uSunColor;
/** Height of the camera, metres — thins the haze band as you climb. */
uniform float uCameraHeight;

varying vec3 vDirection;

void main() {
  vec3 dir = normalize(vDirection);
  vec3 sun = normalize(uSunDirection);

  // Elevation above the horizon, 0 at the horizon and 1 at the zenith.
  float up = clamp(dir.y, 0.0, 1.0);

  // Exponent shapes how tightly the bright band hugs the horizon. Climbing
  // compresses it, which is what makes the plateau feel high.
  float compress = mix(0.42, 0.78, clamp(uCameraHeight / 3800.0, 0.0, 1.0));
  float t = pow(up, compress);
  vec3 color = mix(uHorizonColor, uZenithColor, t);

  float cosAngle = dot(dir, sun);

  // Forward scattering: a broad glow around the sun, strongest near the horizon.
  float glow = pow(max(cosAngle, 0.0), 6.0);
  color += uSunColor * glow * 0.28 * (1.0 - t * 0.6);

  // Wide aureole, which is what actually sells a hazy maritime sky.
  float aureole = pow(max(cosAngle, 0.0), 1.6);
  color += uSunColor * aureole * 0.09;

  // The disc itself. ~0.53 degrees across, softened slightly so it does not
  // alias into a flickering dot at this resolution.
  float disc = smoothstep(0.99976, 0.99992, cosAngle);
  color += uSunColor * disc * 9.0;

  // Below the horizon the dome is only visible past the edge of the sea plane,
  // so it darkens rather than mirroring the sky.
  color *= mix(0.55, 1.0, smoothstep(-0.06, 0.02, dir.y));

  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
