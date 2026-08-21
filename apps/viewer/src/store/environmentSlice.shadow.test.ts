/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2670 review: cast-shadow softness is a property of the sky, so switching
 * lighting preset must seed `envSunAngle` from the preset (Overcast soft, Day
 * crisp) — the same way the terminator already follows `sunSoftness`. And the
 * shadow-map resolution defaults to Auto (0), a device-picked size, rather than
 * a fixed 2048.
 *
 * These drive the REAL slice actions (not a re-read of state), so a regression
 * that unwires the seed from `setEnvPreset` fails here.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createEnvironmentSlice, type EnvironmentSlice } from './slices/environmentSlice.js';
import { LIGHTING_PRESETS } from '@/lib/lighting-presets';

const savedLS = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const STORAGE_KEY = 'ifc-lite:environment';

function stubLocalStorage(seed?: Record<string, unknown>): void {
  const m = new Map<string, string>();
  if (seed) m.set(STORAGE_KEY, JSON.stringify(seed));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => { m.set(k, v); },
      removeItem: (k: string) => { m.delete(k); },
    },
  });
}

/** A live slice over a minimal zustand-like set/get, so `get()` sees updates. */
function makeSlice(): { get: () => EnvironmentSlice } {
  let state = {} as EnvironmentSlice;
  const set = (patch: unknown) => {
    const p = typeof patch === 'function'
      ? (patch as (s: EnvironmentSlice) => Partial<EnvironmentSlice>)(state)
      : (patch as Partial<EnvironmentSlice>);
    state = { ...state, ...p };
  };
  const get = () => state;
  state = createEnvironmentSlice(set as never, get as never, {} as never);
  return { get };
}

describe('environment slice — cast-shadow softness follows the preset (#2670 review)', () => {
  beforeEach(() => stubLocalStorage());
  afterEach(() => {
    if (savedLS) Object.defineProperty(globalThis, 'localStorage', savedLS);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('seeds envSunAngle from the preset on switch (Overcast softer than Day)', () => {
    const { get } = makeSlice();
    get().setEnvPreset('daylight');
    assert.equal(get().envSunAngle, LIGHTING_PRESETS.daylight.shadowSunAngleDeg);
    get().setEnvPreset('overcast');
    assert.equal(get().envSunAngle, LIGHTING_PRESETS.overcast.shadowSunAngleDeg);
    assert.ok(
      LIGHTING_PRESETS.overcast.shadowSunAngleDeg > LIGHTING_PRESETS.daylight.shadowSunAngleDeg,
      'an overcast sky is a larger, softer source than a clear day',
    );
  });

  it('lets a manual softness override the preset, until the next preset switch reseeds it', () => {
    const { get } = makeSlice();
    get().setEnvPreset('daylight');
    get().setEnvSunAngle(3.5);
    assert.equal(get().envSunAngle, 3.5, 'the slider overrides the seeded value');
    get().setEnvPreset('golden');
    assert.equal(get().envSunAngle, LIGHTING_PRESETS.golden.shadowSunAngleDeg, 'a preset switch reseeds it');
  });

  it('defaults the shadow resolution to Auto (0) for a fresh install', () => {
    const { get } = makeSlice();
    assert.equal(get().envShadowResolution, 0);
    // Auto and the three manual sizes round-trip; anything else falls back to Auto.
    get().setEnvShadowResolution(4096);
    assert.equal(get().envShadowResolution, 4096);
    get().setEnvShadowResolution(1234);
    assert.equal(get().envShadowResolution, 0);
  });

  it('seeds the initial angle from a persisted preset that has no stored sunAngle (#3053)', () => {
    // A stored Overcast with no angle must reopen at Overcast's soft angle, not
    // the clear-sky 0.53 default.
    stubLocalStorage({ preset: 'overcast' });
    const { get } = makeSlice();
    assert.equal(get().envSunAngle, LIGHTING_PRESETS.overcast.shadowSunAngleDeg);
  });

  it('preserves a stored manual sunAngle over the preset default', () => {
    stubLocalStorage({ preset: 'overcast', sunAngle: 0.9 });
    const { get } = makeSlice();
    assert.equal(get().envSunAngle, 0.9);
  });
});
