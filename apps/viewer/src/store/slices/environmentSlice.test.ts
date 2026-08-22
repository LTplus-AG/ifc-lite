/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createEnvironmentSlice, type EnvironmentSlice } from './environmentSlice.js';

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

  it('envPanelOpen is session-only: toggling it does not touch persisted storage', () => {
    const s = makeStore();
    s.getState().toggleEnvPanel();
    assert.strictEqual(s.getState().envPanelOpen, true);
    assert.strictEqual(localStorage.getItem(STORAGE_KEY), null);
  });
});
