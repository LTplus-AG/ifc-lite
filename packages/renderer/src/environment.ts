/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lighting environment for the main shading pipelines and the procedural
 * sky pass.
 *
 * Every field is optional; the defaults reproduce the renderer's historical
 * hardcoded look exactly (sun at normalize(0.5, 1, 0.3), hemisphere ambient,
 * 0.85 exposure), so callers that never pass `RenderOptions.environment`
 * see no visual change.
 *
 * Directions are in viewer/world space (Y-up). `sunDirection` points TOWARD
 * the sun, matching the shader's `dot(N, sunDirection)` convention.
 */

export type Vec3Color = [number, number, number];

export interface SkyGradient {
  /** Colour straight up. */
  zenith: Vec3Color;
  /** Colour at the horizon band. */
  horizon: Vec3Color;
  /** Colour below the horizon. */
  ground: Vec3Color;
}

export interface LightingEnvironment {
  /** Unit vector toward the sun (Y-up viewer space). Normalized defensively. */
  sunDirection?: [number, number, number];
  sunColor?: Vec3Color;
  /** Diffuse strength of the sun term (historic default 0.55). */
  sunIntensity?: number;
  /** Hemisphere-ambient sky colour (historic default [0.3, 0.35, 0.4]). */
  skyColor?: Vec3Color;
  /** Hemisphere-ambient ground colour (historic default [0.15, 0.1, 0.08]). */
  groundColor?: Vec3Color;
  /** Hemisphere ambient strength (historic default 0.25). */
  ambientIntensity?: number;
  /** Fixed fill-light strength (historic default 0.15). */
  fillIntensity?: number;
  /** Rim-light strength (historic default 0.15). */
  rimIntensity?: number;
  /** Pre-tonemap exposure multiplier (historic default 0.85). */
  exposure?: number;
  /**
   * Draw the procedural sky background. When false (default) the frame
   * clears to `RenderOptions.clearColor` exactly as before.
   */
  skyEnabled?: boolean;
  /**
   * Optional explicit sky gradient for the sky pass. When omitted, a
   * palette is derived from the sun's altitude (day → golden hour →
   * twilight → night).
   */
  sky?: Partial<SkyGradient>;
}

/** `LightingEnvironment` with every field populated. */
export type ResolvedEnvironment = Required<Omit<LightingEnvironment, 'sky'>> & {
  sky: SkyGradient;
};

/** Historic hardcoded sun direction, normalized: (0.5, 1, 0.3) / |…|. */
const DEFAULT_SUN_DIR: [number, number, number] = (() => {
  const len = Math.hypot(0.5, 1.0, 0.3);
  return [0.5 / len, 1.0 / len, 0.3 / len];
})();

function normalized(v: [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 1e-6)) return [...DEFAULT_SUN_DIR];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerp3(a: Vec3Color, b: Vec3Color, t: number): Vec3Color {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Clamped 0..1 smooth interpolation parameter between two stops. */
function band(x: number, lo: number, hi: number): number {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/**
 * Derive a sky gradient from the sun's elevation (the Y component of the
 * unit sun direction = sin(altitude)). Four keyed palettes blended smoothly:
 * night → twilight → golden hour → day.
 */
export function deriveSkyGradient(sunElevation: number): SkyGradient {
  const night: SkyGradient = {
    zenith: [0.012, 0.016, 0.035],
    horizon: [0.03, 0.04, 0.07],
    ground: [0.015, 0.015, 0.02],
  };
  const twilight: SkyGradient = {
    zenith: [0.07, 0.08, 0.18],
    horizon: [0.45, 0.22, 0.18],
    ground: [0.05, 0.04, 0.05],
  };
  // Ground tones stay near-neutral grey: BIM cameras spend most of their
  // time looking DOWN, so the below-horizon colour fills the screen — a
  // warm "earth" tone reads as a mud-brown background there.
  const golden: SkyGradient = {
    zenith: [0.18, 0.32, 0.56],
    horizon: [0.95, 0.55, 0.28],
    ground: [0.11, 0.105, 0.105],
  };
  const day: SkyGradient = {
    zenith: [0.18, 0.40, 0.78],
    horizon: [0.66, 0.78, 0.90],
    ground: [0.14, 0.145, 0.15],
  };

  // sin(altitude) stops: night below -0.21 (~-12°), twilight to ~0,
  // golden to ~0.17 (~10°), full day above ~0.35 (~20°).
  const tTwilight = band(sunElevation, -0.21, -0.02);
  const tGolden = band(sunElevation, -0.02, 0.17);
  const tDay = band(sunElevation, 0.17, 0.35);

  let g = night;
  g = {
    zenith: lerp3(g.zenith, twilight.zenith, tTwilight),
    horizon: lerp3(g.horizon, twilight.horizon, tTwilight),
    ground: lerp3(g.ground, twilight.ground, tTwilight),
  };
  g = {
    zenith: lerp3(g.zenith, golden.zenith, tGolden),
    horizon: lerp3(g.horizon, golden.horizon, tGolden),
    ground: lerp3(g.ground, golden.ground, tGolden),
  };
  g = {
    zenith: lerp3(g.zenith, day.zenith, tDay),
    horizon: lerp3(g.horizon, day.horizon, tDay),
    ground: lerp3(g.ground, day.ground, tDay),
  };
  return g;
}

/** Fill in defaults; the result always renders identically to the legacy look when `env` is undefined/empty. */
export function resolveEnvironment(env?: LightingEnvironment): ResolvedEnvironment {
  const sunDirection = normalized(env?.sunDirection ?? DEFAULT_SUN_DIR);
  const derived = deriveSkyGradient(sunDirection[1]);
  return {
    sunDirection,
    sunColor: env?.sunColor ?? [1, 1, 1],
    sunIntensity: env?.sunIntensity ?? 0.55,
    skyColor: env?.skyColor ?? [0.3, 0.35, 0.4],
    groundColor: env?.groundColor ?? [0.15, 0.1, 0.08],
    ambientIntensity: env?.ambientIntensity ?? 0.25,
    fillIntensity: env?.fillIntensity ?? 0.15,
    rimIntensity: env?.rimIntensity ?? 0.15,
    exposure: env?.exposure ?? 0.85,
    skyEnabled: env?.skyEnabled ?? false,
    sky: {
      zenith: env?.sky?.zenith ?? derived.zenith,
      horizon: env?.sky?.horizon ?? derived.horizon,
      ground: env?.sky?.ground ?? derived.ground,
    },
  };
}

/** Byte size of the packed environment UBO (must match the WGSL struct). */
export const ENVIRONMENT_UNIFORM_SIZE = 80;

/**
 * Pack the resolved environment into the `Environment` WGSL struct layout:
 *
 *   sunDirection: vec3 + sunIntensity: f32      → floats 0..3
 *   sunColor: vec3     + ambientIntensity: f32  → floats 4..7
 *   skyColor: vec3     + exposure: f32          → floats 8..11
 *   groundColor: vec3  + fillIntensity: f32     → floats 12..15
 *   rimIntensity: f32  + 3 pad floats           → floats 16..19
 */
export function packEnvironmentUniforms(
  env: ResolvedEnvironment,
  out?: Float32Array,
): Float32Array {
  const buf = out ?? new Float32Array(ENVIRONMENT_UNIFORM_SIZE / 4);
  buf[0] = env.sunDirection[0];
  buf[1] = env.sunDirection[1];
  buf[2] = env.sunDirection[2];
  buf[3] = env.sunIntensity;
  buf[4] = env.sunColor[0];
  buf[5] = env.sunColor[1];
  buf[6] = env.sunColor[2];
  buf[7] = env.ambientIntensity;
  buf[8] = env.skyColor[0];
  buf[9] = env.skyColor[1];
  buf[10] = env.skyColor[2];
  buf[11] = env.exposure;
  buf[12] = env.groundColor[0];
  buf[13] = env.groundColor[1];
  buf[14] = env.groundColor[2];
  buf[15] = env.fillIntensity;
  buf[16] = env.rimIntensity;
  buf[17] = 0;
  buf[18] = 0;
  buf[19] = 0;
  return buf;
}
