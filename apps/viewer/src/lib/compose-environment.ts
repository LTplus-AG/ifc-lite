/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compose the renderer's lighting environment from a lighting preset and the
 * user's Phase-1 trims (exposure, light hardness, terminator softness), plus
 * the optional live sun override from the solar study.
 *
 * The trims mirror how Exposure already worked: the PRESET supplies the base
 * look, so switching presets changes the base while the trims persist. That is
 * the "if it describes the light it is a preset" split — hardness/softness are
 * real properties of the sky being simulated (a clear day is crisp, overcast is
 * soft), and the trim lets the user push that further without editing presets.
 *
 * Kept as a pure function (no store, no React) so it can be unit-tested against
 * the resulting uniform values rather than through the Viewport component.
 */

import type { LightingEnvironment } from '@ifc-lite/renderer';
import { sunLightingForAltitude } from './geo/solar-direction.js';

export interface EnvironmentTrims {
  /** Exposure trim, multiplied onto the preset exposure. 1 = neutral. */
  exposure: number;
  /**
   * Light hardness. 1 = neutral. Above 1 deepens shadows by dividing the
   * hemisphere ambient + fill; below 1 flattens the light.
   */
  hardness: number;
  /**
   * Terminator-softness trim, multiplied onto the preset's `sunSoftness`
   * (renderer default 0.3). 1 = neutral. The renderer clamps to [0, 1].
   */
  softness: number;
}

export interface SolarOverride {
  /** Sun direction in viewer world space (Y-up), toward the sun. */
  sunDirection: [number, number, number];
  /** Resolved sun altitude in degrees. */
  altitudeDeg: number;
}

export interface ComposeOptions {
  /** World-context (Cesium) active — the WebGPU sky stays off while it is. */
  cesiumActive: boolean;
  /** Live sun from the solar study, or null/undefined when it is off. */
  solar?: SolarOverride | null;
}

export function composeLightingEnvironment(
  preset: LightingEnvironment,
  trims: EnvironmentTrims,
  opts: ComposeOptions,
): LightingEnvironment {
  const { exposure, hardness, softness } = trims;
  const env: LightingEnvironment = {
    ...preset,
    skyEnabled: (preset.skyEnabled ?? false) && !opts.cesiumActive,
    exposure: (preset.exposure ?? 0.85) * exposure,
    // Terminator softness: user trim on the preset's base wrap. The renderer
    // clamps the product to [0, 1].
    sunSoftness: (preset.sunSoftness ?? 0.3) * softness,
  };
  if (opts.solar) {
    const sun = sunLightingForAltitude(opts.solar.altitudeDeg);
    env.sunDirection = opts.solar.sunDirection;
    env.sunColor = sun.color;
    env.sunIntensity = (preset.sunIntensity ?? 0.55) * sun.intensityFactor;
    env.ambientIntensity = (preset.ambientIntensity ?? 0.25) * sun.ambientFactor;
    // Let the sky derive its palette from the real sun altitude.
    delete env.sky;
  }
  // Light hardness: deepen shadows by cutting the hemisphere ambient + fill.
  // Applied last so it composes over the solar override's ambient too.
  if (hardness !== 1) {
    env.ambientIntensity = (env.ambientIntensity ?? 0.25) / hardness;
    env.fillIntensity = (env.fillIntensity ?? 0.15) / hardness;
  }
  return env;
}
