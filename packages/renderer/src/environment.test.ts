/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  resolveEnvironment,
  packEnvironmentUniforms,
  deriveSkyGradient,
  ENVIRONMENT_UNIFORM_SIZE,
} from './environment.js';

function assertClose(actual: number, expected: number, eps = 1e-6, msg?: string) {
  assert.ok(Math.abs(actual - expected) < eps, msg ?? `${actual} !≈ ${expected}`);
}

describe('resolveEnvironment', () => {
  it('defaults reproduce the historic hardcoded look', () => {
    const env = resolveEnvironment();
    // normalize(0.5, 1.0, 0.3) — the shader's old sunLight constant.
    const len = Math.hypot(0.5, 1.0, 0.3);
    assertClose(env.sunDirection[0], 0.5 / len);
    assertClose(env.sunDirection[1], 1.0 / len);
    assertClose(env.sunDirection[2], 0.3 / len);
    assert.strictEqual(env.sunIntensity, 0.55);
    assert.deepStrictEqual(env.sunColor, [1, 1, 1]);
    assert.deepStrictEqual(env.skyColor, [0.3, 0.35, 0.4]);
    assert.deepStrictEqual(env.groundColor, [0.15, 0.1, 0.08]);
    assert.strictEqual(env.ambientIntensity, 0.25);
    assert.strictEqual(env.fillIntensity, 0.15);
    assert.strictEqual(env.rimIntensity, 0.15);
    assert.strictEqual(env.exposure, 0.85);
    assert.strictEqual(env.skyEnabled, false);
  });

  it('normalizes a non-unit sun direction', () => {
    const env = resolveEnvironment({ sunDirection: [0, 2, 0] });
    assert.deepStrictEqual(env.sunDirection, [0, 1, 0]);
  });

  it('falls back to the default sun for a degenerate direction', () => {
    const env = resolveEnvironment({ sunDirection: [0, 0, 0] });
    assert.ok(env.sunDirection[1] > 0.5);
    assertClose(Math.hypot(...env.sunDirection), 1);
  });

  it('honours explicit sky overrides and derives the rest', () => {
    const env = resolveEnvironment({
      sunDirection: [0, 1, 0],
      sky: { zenith: [0, 0, 1] },
    });
    assert.deepStrictEqual(env.sky.zenith, [0, 0, 1]);
    // horizon/ground come from the altitude-derived palette (midday → bright horizon)
    assert.ok(env.sky.horizon[0] > 0.3);
  });
});

describe('packEnvironmentUniforms', () => {
  it('packs the WGSL struct layout exactly', () => {
    const env = resolveEnvironment({
      sunDirection: [1, 0, 0],
      sunColor: [0.9, 0.8, 0.7],
      sunIntensity: 0.6,
      skyColor: [0.1, 0.2, 0.3],
      groundColor: [0.4, 0.5, 0.6],
      ambientIntensity: 0.3,
      fillIntensity: 0.11,
      rimIntensity: 0.12,
      exposure: 1.0,
    });
    const buf = packEnvironmentUniforms(env);
    assert.strictEqual(buf.byteLength, ENVIRONMENT_UNIFORM_SIZE);
    assert.deepStrictEqual(Array.from(buf.slice(0, 4)), [1, 0, 0, Math.fround(0.6)]);
    assertClose(buf[4], 0.9);
    assertClose(buf[7], 0.3);
    assertClose(buf[8], 0.1);
    assertClose(buf[11], 1.0);
    assertClose(buf[12], 0.4);
    assertClose(buf[15], 0.11);
    assertClose(buf[16], 0.12);
  });

  it('reuses the caller-provided output buffer', () => {
    const out = new Float32Array(ENVIRONMENT_UNIFORM_SIZE / 4);
    const env = resolveEnvironment();
    assert.strictEqual(packEnvironmentUniforms(env, out), out);
  });
});

describe('deriveSkyGradient', () => {
  it('is dark at night and bright at midday', () => {
    const night = deriveSkyGradient(-0.5);
    const day = deriveSkyGradient(0.8);
    assert.ok(night.zenith[2] < 0.1);
    assert.ok(day.zenith[2] > 0.5);
  });

  it('warms the horizon at golden hour', () => {
    const golden = deriveSkyGradient(0.08);
    // Horizon red channel dominates blue near sunrise/sunset.
    assert.ok(golden.horizon[0] > golden.horizon[2]);
    // Midday horizon is cool (blue ≥ red).
    const day = deriveSkyGradient(0.8);
    assert.ok(day.horizon[2] >= day.horizon[0]);
  });

  it('blends continuously across the twilight boundary', () => {
    const a = deriveSkyGradient(-0.021);
    const b = deriveSkyGradient(-0.019);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(a.zenith[i] - b.zenith[i]) < 0.02);
    }
  });
});
