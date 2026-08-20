/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGeometryLoadSettings,
  geometryLoadSettingsInitialState,
  type GeometryLoadSettingsState,
} from './geometryLoadSettings.js';
import {
  MERGE_LAYERS_STORAGE_KEY,
  GEOMETRY_MODE_STORAGE_KEY,
} from '../constants.js';
import { GEOM_TIER_STORAGE_KEY } from '../geometryFidelity.js';

/** Minimal set/get harness so the slice's actions run against a plain object,
 *  no zustand store needed - `createGeometryLoadSettings` only depends on the
 *  `set`/`get`/`isModelLoaded` contract. */
function makeHarness(overrides: Partial<GeometryLoadSettingsState> = {}) {
  let state: GeometryLoadSettingsState = { ...geometryLoadSettingsInitialState, ...overrides };
  let modelLoaded = false;
  const set = (partial: Partial<GeometryLoadSettingsState>) => {
    state = { ...state, ...partial };
  };
  const get = () => state;
  const actions = createGeometryLoadSettings(set, get, () => modelLoaded);
  return {
    actions,
    getState: () => state,
    setModelLoaded: (v: boolean) => { modelLoaded = v; },
  };
}

describe('geometryLoadSettings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('does not arm the reload prompt when no model is loaded', () => {
    const h = makeHarness();
    h.setModelLoaded(false);
    h.actions.setMergeLayers(true);
    assert.strictEqual(h.getState().mergeLayers, true);
    assert.strictEqual(h.getState().mergeLayersPendingReload, false);
  });

  it('arms the reload prompt when a model is in scope', () => {
    const h = makeHarness();
    h.setModelLoaded(true);
    h.actions.setMergeLayers(true);
    assert.strictEqual(h.getState().mergeLayersPendingReload, true);
  });

  it('setMergeLayers persists to localStorage', () => {
    const h = makeHarness();
    h.actions.setMergeLayers(true);
    assert.strictEqual(localStorage.getItem(MERGE_LAYERS_STORAGE_KEY), 'true');
    h.actions.setMergeLayers(false);
    assert.strictEqual(localStorage.getItem(MERGE_LAYERS_STORAGE_KEY), 'false');
  });

  it('setMergeLayers with the same value is a no-op: no reload prompt, no re-persist churn', () => {
    const h = makeHarness({ mergeLayers: true });
    h.setModelLoaded(true);
    h.actions.setMergeLayers(true);
    // Same value as current: the early-return path. Reload flag must stay
    // false - flipping it here would prompt the user for a change that
    // never happened.
    assert.strictEqual(h.getState().mergeLayersPendingReload, false);
  });

  it('clearMergeLayersPendingReload only clears the merge-layers flag', () => {
    const h = makeHarness();
    h.setModelLoaded(true);
    h.actions.setMergeLayers(true);
    h.actions.setGeometryMode('exact');
    assert.strictEqual(h.getState().mergeLayersPendingReload, true);
    assert.strictEqual(h.getState().geometryModePendingReload, true);
    h.actions.clearMergeLayersPendingReload();
    assert.strictEqual(h.getState().mergeLayersPendingReload, false);
    // The unrelated geometry-mode banner must survive: acknowledging one
    // reload prompt must not silently dismiss the other.
    assert.strictEqual(h.getState().geometryModePendingReload, true);
  });

  it('setGeometryMode tags the reload reason as "mode" and persists', () => {
    const h = makeHarness();
    h.setModelLoaded(true);
    h.actions.setGeometryMode('exact');
    assert.strictEqual(h.getState().geometryMode, 'exact');
    assert.strictEqual(h.getState().geometryModePendingReload, true);
    assert.strictEqual(h.getState().geometryReloadReason, 'mode');
    assert.strictEqual(localStorage.getItem(GEOMETRY_MODE_STORAGE_KEY), 'exact');
  });

  it('setGeometryMode with the same value is a no-op', () => {
    const h = makeHarness({ geometryMode: 'fast' });
    h.setModelLoaded(true);
    h.actions.setGeometryMode('fast');
    assert.strictEqual(h.getState().geometryModePendingReload, false);
  });

  it('clearGeomTierOverride tags the reload reason as "tier", not "mode"', () => {
    localStorage.setItem(GEOM_TIER_STORAGE_KEY, 'high');
    const h = makeHarness({ geomTierOverride: 'high' });
    h.setModelLoaded(true);
    h.actions.clearGeomTierOverride();
    assert.strictEqual(h.getState().geomTierOverride, undefined);
    assert.strictEqual(h.getState().geometryModePendingReload, true);
    assert.strictEqual(h.getState().geometryReloadReason, 'tier');
    assert.strictEqual(localStorage.getItem(GEOM_TIER_STORAGE_KEY), null);
  });

  it('clearGeomTierOverride is a no-op when already undefined (no false reload prompt)', () => {
    const h = makeHarness({ geomTierOverride: undefined });
    h.setModelLoaded(true);
    h.actions.clearGeomTierOverride();
    assert.strictEqual(h.getState().geometryModePendingReload, false);
  });

  it('clearGeometryModePendingReload clears the flag independent of merge-layers', () => {
    const h = makeHarness();
    h.setModelLoaded(true);
    h.actions.setGeometryMode('exact');
    h.actions.clearGeometryModePendingReload();
    assert.strictEqual(h.getState().geometryModePendingReload, false);
  });
});
