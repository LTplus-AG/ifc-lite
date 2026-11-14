/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createSpaceMouseSlice, type SpaceMouseSlice } from './spaceMouseSlice.js';
import { SENSITIVITY } from '@/lib/spacemouse/constants';

const STORAGE_KEY = 'ifc-lite:spacemouse';

const makeStore = () => createStore<SpaceMouseSlice>(createSpaceMouseSlice);

describe('spaceMouseSlice', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('setSpaceMouseConnected(true, name) clears a stale error and stores the device name', () => {
    const s = makeStore();
    s.getState().setSpaceMouseError('device not found');
    s.getState().setSpaceMouseConnected(true, 'SpaceMouse Pro');
    assert.strictEqual(s.getState().spaceMouseConnected, true);
    assert.strictEqual(s.getState().spaceMouseDeviceName, 'SpaceMouse Pro');
    assert.strictEqual(s.getState().spaceMouseError, null);
  });

  it('setSpaceMouseConnected(false) drops the device name even if one was passed', () => {
    const s = makeStore();
    s.getState().setSpaceMouseConnected(true, 'SpaceMouse Pro');
    s.getState().setSpaceMouseConnected(false, 'SpaceMouse Pro');
    assert.strictEqual(s.getState().spaceMouseDeviceName, null);
  });

  it('setSpaceMouseConnected(false) does not touch an existing error', () => {
    const s = makeStore();
    s.getState().setSpaceMouseError('disconnected unexpectedly');
    s.getState().setSpaceMouseConnected(false);
    // Disconnecting must not silently erase the reason - only a fresh
    // successful connection clears the error.
    assert.strictEqual(s.getState().spaceMouseError, 'disconnected unexpectedly');
  });

  it('setSpaceMouseSensitivity clamps to [min, max] and persists', () => {
    const s = makeStore();
    s.getState().setSpaceMouseSensitivity(SENSITIVITY.max + 50);
    assert.strictEqual(s.getState().spaceMouseSensitivity, SENSITIVITY.max);
    s.getState().setSpaceMouseSensitivity(SENSITIVITY.min - 50);
    assert.strictEqual(s.getState().spaceMouseSensitivity, SENSITIVITY.min);
    const raw = localStorage.getItem(STORAGE_KEY);
    assert.ok(raw);
    assert.strictEqual(JSON.parse(raw!).sensitivity, SENSITIVITY.min);
  });

  it('setSpaceMouseSensitivity(NaN) falls back to the default rather than persisting NaN', () => {
    const s = makeStore();
    s.getState().setSpaceMouseSensitivity(Number.NaN);
    assert.strictEqual(s.getState().spaceMouseSensitivity, SENSITIVITY.default);
    assert.strictEqual(Number.isNaN(s.getState().spaceMouseSensitivity), false);
  });

  it('loads a discriminating persisted sensitivity on construction, clamped', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sensitivity: SENSITIVITY.max + 100 }));
    const s = makeStore();
    assert.strictEqual(s.getState().spaceMouseSensitivity, SENSITIVITY.max);
  });

  it('a corrupt persisted entry falls back to the default instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, 'not json at all');
    assert.doesNotThrow(() => makeStore());
    const s = makeStore();
    assert.strictEqual(s.getState().spaceMouseSensitivity, SENSITIVITY.default);
  });

  it('a persisted entry missing the sensitivity field falls back to the default', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ somethingElse: 1 }));
    const s = makeStore();
    assert.strictEqual(s.getState().spaceMouseSensitivity, SENSITIVITY.default);
  });

  // #9131: the opt-in driver path is off unless the user turned it on.
  it('the 3Dconnexion driver opt-in is off by default and survives a reload once turned on', () => {
    assert.strictEqual(makeStore().getState().spaceMouseUseDriver, false);
    makeStore().getState().setSpaceMouseUseDriver(true);
    assert.strictEqual(makeStore().getState().spaceMouseUseDriver, true);
    makeStore().getState().setSpaceMouseUseDriver(false);
    assert.strictEqual(makeStore().getState().spaceMouseUseDriver, false);
  });

  it('the driver opt-in does not disturb the persisted sensitivity entry (#9131)', () => {
    const s = makeStore();
    s.getState().setSpaceMouseSensitivity(SENSITIVITY.max);
    s.getState().setSpaceMouseUseDriver(true);
    assert.strictEqual(makeStore().getState().spaceMouseSensitivity, SENSITIVITY.max);
  });

  it('a corrupt driver preference falls back to off (#9131)', () => {
    localStorage.setItem('ifc-lite:spacemouse-driver', '{not json');
    assert.strictEqual(makeStore().getState().spaceMouseUseDriver, false);
    localStorage.setItem('ifc-lite:spacemouse-driver', JSON.stringify({ enabled: 'yes' }));
    assert.strictEqual(makeStore().getState().spaceMouseUseDriver, false);
  });

  it('a driver error is kept only while the driver path is unavailable (#9131)', () => {
    const s = makeStore();
    s.getState().setSpaceMouseDriverStatus('unavailable', 'driver not reachable');
    assert.strictEqual(s.getState().spaceMouseDriverError, 'driver not reachable');
    s.getState().setSpaceMouseDriverStatus('connected', 'stale');
    assert.strictEqual(s.getState().spaceMouseDriverError, null);
  });
});
