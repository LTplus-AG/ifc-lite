/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createEnvironmentSlice, type EnvironmentSlice } from './environmentSlice.js';
import { LIGHTING_PRESETS } from '@/lib/lighting-presets';

const STORAGE_KEY = 'ifc-lite:environment';

const makeStore = () => createStore<EnvironmentSlice>(createEnvironmentSlice);

describe('environmentSlice', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults sky off and a neutral 1x trim on every dial', () => {
    const s = makeStore();
    assert.strictEqual(s.getState().envPreset, 'default');
    assert.strictEqual(s.getState().envSkyEnabled, false);
    assert.strictEqual(s.getState().envExposure, 1);
    assert.strictEqual(s.getState().envHardness, 1);
    assert.strictEqual(s.getState().envSoftness, 1);
  });

  it('setEnvExposure clamps to [0.4, 2] rather than accepting an out-of-range value', () => {
    const s = makeStore();
    s.getState().setEnvExposure(5);
    assert.strictEqual(s.getState().envExposure, 2);
    s.getState().setEnvExposure(-3);
    assert.strictEqual(s.getState().envExposure, 0.4);
    s.getState().setEnvExposure(1.5);
    assert.strictEqual(s.getState().envExposure, 1.5);
  });

  it('setEnvExposure(NaN) falls back to the neutral default instead of storing NaN', () => {
    const s = makeStore();
    s.getState().setEnvExposure(Number.NaN);
    // Number() of a bad user-typed value, or a corrupt persisted entry,
    // must not defeat every later >= / <= comparison against this field.
    assert.strictEqual(s.getState().envExposure, 1);
    assert.strictEqual(Number.isNaN(s.getState().envExposure), false);
  });

  it('setEnvHardness and setEnvSoftness clamp to their own distinct ranges', () => {
    const s = makeStore();
    s.getState().setEnvHardness(0.1);
    assert.strictEqual(s.getState().envHardness, 0.5); // hardness floor is 0.5, not 0
    s.getState().setEnvSoftness(0.1);
    assert.strictEqual(s.getState().envSoftness, 0.1); // softness floor is 0, so 0.1 passes through
    s.getState().setEnvSoftness(-1);
    assert.strictEqual(s.getState().envSoftness, 0);
  });

  it('persists every dial together on any single setter call', () => {
    const s = makeStore();
    s.getState().setEnvPreset('golden');
    s.getState().setEnvExposure(1.8);
    const raw = localStorage.getItem(STORAGE_KEY);
    assert.ok(raw, 'expected environment settings to be persisted');
    const parsed = JSON.parse(raw!);
    assert.strictEqual(parsed.exposure, 1.8);
    // The preset set in the prior call must not have been dropped by the
    // later setter overwriting the whole persisted blob.
    assert.strictEqual(parsed.preset, 'golden');
  });

  it('rehydrates a discriminating set of persisted values on next construction', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      preset: 'daylight',
      skyEnabled: true,
      exposure: 1.7,
      hardness: 1.3,
      softness: 0.2,
    }));
    const s = makeStore();
    assert.strictEqual(s.getState().envSkyEnabled, true);
    assert.strictEqual(s.getState().envExposure, 1.7);
    assert.strictEqual(s.getState().envHardness, 1.3);
    assert.strictEqual(s.getState().envSoftness, 0.2);
  });

  it('rejects an unknown persisted preset id, falling back to default', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset: 'not-a-real-preset' }));
    const s = makeStore();
    assert.strictEqual(s.getState().envPreset, 'default');
  });

  it('ignores a corrupt (non-JSON) persisted entry rather than throwing at construction', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json');
    assert.doesNotThrow(() => makeStore());
    const s = makeStore();
    assert.strictEqual(s.getState().envExposure, 1);
  });

  // The three dials below were the ones this file did NOT reach. Verified by
  // mutation: deleting `clampSunAngle`'s range clamp, `clampSunTime`'s range
  // clamp or `clampShadowResolution`'s allow-list snap outright — and each of
  // their `Number.isFinite` fallbacks — left the suite fully green, while the
  // same treatment of `clampExposure`/`clampHardness`/`clampSoftness` turned
  // it red. Exposure was pinned; the rest were not.
  it('setEnvSunAngle clamps to [0.1, 5] and rejects NaN', () => {
    const s = makeStore();
    s.getState().setEnvSunAngle(50);
    assert.strictEqual(s.getState().envSunAngle, 5);
    s.getState().setEnvSunAngle(-1);
    assert.strictEqual(s.getState().envSunAngle, 0.1);
    s.getState().setEnvSunAngle(2.5);
    assert.strictEqual(s.getState().envSunAngle, 2.5);
    s.getState().setEnvSunAngle(Number.NaN);
    // The renderer divides by / compares against this angle when sizing the
    // penumbra; NaN here poisons the shadow term rather than widening it.
    assert.strictEqual(s.getState().envSunAngle, 0.53);
  });

  it('setEnvSunTime clamps to the 6..18 sun-arc day window and rejects NaN', () => {
    const s = makeStore();
    s.getState().setEnvSunTime(23);
    assert.strictEqual(s.getState().envSunTime, 18);
    s.getState().setEnvSunTime(0);
    assert.strictEqual(s.getState().envSunTime, 6);
    s.getState().setEnvSunTime(9.5);
    assert.strictEqual(s.getState().envSunTime, 9.5);
    s.getState().setEnvSunTime(Number.NaN);
    assert.strictEqual(s.getState().envSunTime, 13);
  });

  it('setEnvShadowResolution snaps to a supported size, falling back to 0 (Auto)', () => {
    const s = makeStore();
    s.getState().setEnvShadowResolution(2048);
    assert.strictEqual(s.getState().envShadowResolution, 2048);
    // 8192 is a plausible-looking value that is NOT on the allow-list; it must
    // become Auto rather than be handed to the renderer as a texture size.
    s.getState().setEnvShadowResolution(8192);
    assert.strictEqual(s.getState().envShadowResolution, 0);
    // NaN lands on Auto too — though note that `clampShadowResolution`'s own
    // `Number.isFinite` early return is redundant for this input: `includes`
    // uses SameValueZero, so `[0, 1024, 2048, 4096].includes(NaN)` is already
    // false and the allow-list branch returns 0 by itself. Deleting that early
    // return leaves this assertion green.
    s.getState().setEnvShadowResolution(Number.NaN);
    assert.strictEqual(s.getState().envShadowResolution, 0);
  });

  it('setEnvPreset re-seeds envSunAngle from the preset, overriding a manual angle', () => {
    // louistrue's #2670 review: cast-shadow softness is a property of the sky,
    // so switching preset must move the angle with it. Nothing pinned this.
    const s = makeStore();
    s.getState().setEnvSunAngle(2.5);
    s.getState().setEnvPreset('overcast');
    assert.strictEqual(
      s.getState().envSunAngle,
      LIGHTING_PRESETS.overcast.shadowSunAngleDeg,
      'a preset switch must carry its own sun angle, not keep the manual override',
    );
    // And a preset with a *different* angle, so the assertion cannot pass on a
    // shared default: overcast is 4.0, golden is 0.8.
    s.getState().setEnvPreset('golden');
    assert.strictEqual(s.getState().envSunAngle, LIGHTING_PRESETS.golden.shadowSunAngleDeg);
  });

  it('with no stored angle, seeds envSunAngle from the RESTORED preset, not a fixed 0.53', () => {
    // CodeRabbit #3053: a persisted Overcast used to reopen crisp (0.53) until
    // the first preset switch. `sunAngle` is deliberately absent here.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset: 'overcast' }));
    const s = makeStore();
    assert.strictEqual(s.getState().envSunAngle, LIGHTING_PRESETS.overcast.shadowSunAngleDeg);
    assert.notStrictEqual(s.getState().envSunAngle, LIGHTING_PRESETS.default.shadowSunAngleDeg);
  });

  it('a stored sunAngle override survives rehydration and is not overwritten by the preset', () => {
    // The other direction of the same rule — the #3053 fix must not turn into
    // "the preset always wins".
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset: 'overcast', sunAngle: 1.7 }));
    const s = makeStore();
    assert.strictEqual(s.getState().envSunAngle, 1.7);
  });

  // The three tests above pin the SETTER direction of each clamp. The slice
  // clamps in two places, though: every setter, and once at construction over
  // whatever `loadPersisted()` returns. localStorage is not a trusted input —
  // it survives downgrades, is hand-editable, and is shared across tabs — so
  // the constructor direction is the one that actually faces a hostile value.
  //
  // Verified by mutation: dropping `clampShadowResolution`, `clampSunTime` or
  // `clampSunAngle` from the `initial` object and passing the stored value
  // straight through left the suite 15/15 green before these were added.
  it('clamps a stored shadowResolution that is not a supported size', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ shadowResolution: 8192 }));
    // 8192 reaches the renderer as a shadow-map texture side; only the
    // allow-list stands between a corrupt entry and an allocation failure.
    assert.strictEqual(makeStore().getState().envShadowResolution, 0);
  });

  it('clamps a stored sunTime outside the sun-arc day window', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sunTime: 23 }));
    assert.strictEqual(makeStore().getState().envSunTime, 18);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sunTime: Number.NaN }));
    // JSON.stringify turns NaN into null, which is exactly the shape a
    // corrupt entry takes on disk — and `null ?? 13` keeps the default.
    assert.strictEqual(makeStore().getState().envSunTime, 13);
  });

  it('clamps a stored sunAngle outside [0.1, 5]', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset: 'overcast', sunAngle: 50 }));
    const angle = makeStore().getState().envSunAngle;
    assert.strictEqual(angle, 5);
    // Not the preset's own angle either: the stored override is clamped, not
    // discarded, so this cannot pass by falling back to the preset seed.
    assert.notStrictEqual(angle, LIGHTING_PRESETS.overcast.shadowSunAngleDeg);
  });

  it('envPanelOpen is session-only: toggling it does not touch persisted storage', () => {
    const s = makeStore();
    s.getState().toggleEnvPanel();
    assert.strictEqual(s.getState().envPanelOpen, true);
    assert.strictEqual(localStorage.getItem(STORAGE_KEY), null);
  });
});
