/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveEnvironment } from '@ifc-lite/renderer';
import { composeLightingEnvironment } from './compose-environment.js';
import { LIGHTING_PRESETS } from './lighting-presets.js';

const NEUTRAL = { exposure: 1, hardness: 1, softness: 1 } as const;
const NO_SOLAR = { cesiumActive: false, solar: null } as const;

describe('composeLightingEnvironment — trims', () => {
  it('neutral trims on the Default preset keep the legacy look (base wrap 0.3)', () => {
    const env = composeLightingEnvironment(
      LIGHTING_PRESETS.default.environment,
      NEUTRAL,
      NO_SOLAR,
    );
    assert.strictEqual(env.sunSoftness, 0.3);
    assert.strictEqual(env.exposure, 0.85 * 1);
    // Nothing forced ambient/fill on the empty preset.
    assert.strictEqual(env.ambientIntensity, undefined);
    assert.strictEqual(env.fillIntensity, undefined);
  });

  it('softness trim multiplies the preset base wrap (Overcast 0.85 × 0.5 = 0.425)', () => {
    const env = composeLightingEnvironment(
      LIGHTING_PRESETS.overcast.environment,
      { ...NEUTRAL, softness: 0.5 },
      NO_SOLAR,
    );
    assert.ok(Math.abs((env.sunSoftness ?? 0) - 0.425) < 1e-9);
  });

  it('hardness > 1 deepens shadows by dividing ambient and fill', () => {
    // Day preset: ambient 0.3, no explicit fill (compose falls back to 0.15).
    const env = composeLightingEnvironment(
      LIGHTING_PRESETS.daylight.environment,
      { ...NEUTRAL, hardness: 2 },
      NO_SOLAR,
    );
    assert.ok(Math.abs((env.ambientIntensity ?? 0) - 0.15) < 1e-9);
    assert.ok(Math.abs((env.fillIntensity ?? 0) - 0.075) < 1e-9);
  });

  it('hardness < 1 flattens the light (raises ambient/fill)', () => {
    const env = composeLightingEnvironment(
      LIGHTING_PRESETS.daylight.environment,
      { ...NEUTRAL, hardness: 0.5 },
      NO_SOLAR,
    );
    assert.ok((env.ambientIntensity ?? 0) > 0.3);
  });

  it('composes hardness OVER the solar override (ambient is scaled then divided)', () => {
    const withSolar = composeLightingEnvironment(
      LIGHTING_PRESETS.daylight.environment,
      { ...NEUTRAL, hardness: 2 },
      { cesiumActive: false, solar: { sunDirection: [0, 1, 0], altitudeDeg: 60 } },
    );
    const noHardness = composeLightingEnvironment(
      LIGHTING_PRESETS.daylight.environment,
      NEUTRAL,
      { cesiumActive: false, solar: { sunDirection: [0, 1, 0], altitudeDeg: 60 } },
    );
    // The solar path set ambient from altitude; hardness=2 halves whatever it produced.
    assert.ok(Math.abs((withSolar.ambientIntensity ?? 0) - (noHardness.ambientIntensity ?? 0) / 2) < 1e-9);
    // The solar override also drives the sun direction.
    assert.deepStrictEqual(withSolar.sunDirection, [0, 1, 0]);
  });

  it('keeps the sky OFF in world-context (Cesium) even when the preset enables it', () => {
    assert.strictEqual(LIGHTING_PRESETS.daylight.environment.skyEnabled, true);
    const env = composeLightingEnvironment(
      LIGHTING_PRESETS.daylight.environment,
      NEUTRAL,
      { cesiumActive: true, solar: null },
    );
    assert.strictEqual(env.skyEnabled, false);
  });
});

describe('composeLightingEnvironment — renderer clamp contract', () => {
  it('an over-soft trim is clamped to 1 by the renderer, never exceeding a valid wrap', () => {
    const composed = composeLightingEnvironment(
      LIGHTING_PRESETS.overcast.environment, // base 0.85
      { ...NEUTRAL, softness: 2 },            // → 1.7 before clamp
      NO_SOLAR,
    );
    assert.ok((composed.sunSoftness ?? 0) > 1, 'compose passes the raw product through');
    const resolved = resolveEnvironment(composed);
    assert.strictEqual(resolved.sunSoftness, 1, 'renderer clamps the wrap to [0, 1]');
  });

  it('a zero softness trim yields a crisp terminator (wrap 0) end to end', () => {
    const composed = composeLightingEnvironment(
      LIGHTING_PRESETS.daylight.environment,
      { ...NEUTRAL, softness: 0 },
      NO_SOLAR,
    );
    assert.strictEqual(resolveEnvironment(composed).sunSoftness, 0);
  });
});
