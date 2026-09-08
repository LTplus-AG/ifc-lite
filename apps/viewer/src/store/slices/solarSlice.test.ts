/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createSolarSlice, type SolarSlice } from './solarSlice.js';

const makeStore = () => createStore<SolarSlice>(createSolarSlice);

const info = { latitude: 1, longitude: 2, azimuth: 3, altitude: 4, sunriseMs: 5, sunsetMs: 6, solarNoonMs: 7 };
const dir: [number, number, number] = [0, 1, 0];

describe('solarSlice', () => {
  it('setSolarEnabled(false) clears the resolved sun readout, direction and playing state', () => {
    const s = makeStore();
    s.getState().setSolarEnabled(true);
    s.getState().setSolarSunInfo(info);
    s.getState().setSolarSunDirection(dir);
    s.getState().setSolarPlaying(true);

    s.getState().setSolarEnabled(false);

    assert.strictEqual(s.getState().solarSunInfo, null);
    assert.strictEqual(s.getState().solarSunDirection, null);
    assert.strictEqual(s.getState().solarPlaying, false);
  });

  it('setSolarEnabled(true) does not touch the readout (CesiumOverlay recomputes it)', () => {
    const s = makeStore();
    s.getState().setSolarEnabled(true);
    assert.strictEqual(s.getState().solarEnabled, true);
    assert.strictEqual(s.getState().solarSunInfo, null);
  });

  it('toggleSolar off clears the same fields as an explicit setSolarEnabled(false)', () => {
    const s = makeStore();
    s.getState().setSolarEnabled(true);
    s.getState().setSolarSunInfo(info);
    s.getState().setSolarSunDirection(dir);
    s.getState().setSolarPlaying(true);

    s.getState().toggleSolar();

    assert.strictEqual(s.getState().solarEnabled, false);
    assert.strictEqual(s.getState().solarSunInfo, null);
    assert.strictEqual(s.getState().solarSunDirection, null);
    assert.strictEqual(s.getState().solarPlaying, false);
  });

  it('toggleSolar on does not clear readout state (there is none yet, but must not stomp)', () => {
    const s = makeStore();
    s.getState().toggleSolar();
    assert.strictEqual(s.getState().solarEnabled, true);
  });

  it('setSolarDateMs / setSolarShowSunPath / setSolarShowShadows do not affect solarEnabled or the readout', () => {
    const s = makeStore();
    s.getState().setSolarEnabled(true);
    s.getState().setSolarSunInfo(info);
    s.getState().setSolarDateMs(123);
    s.getState().setSolarShowSunPath(false);
    s.getState().setSolarShowShadows(false);
    assert.strictEqual(s.getState().solarEnabled, true);
    assert.deepStrictEqual(s.getState().solarSunInfo, info);
  });

  it('toggleSolarPlaying flips independent of solarEnabled', () => {
    const s = makeStore();
    assert.strictEqual(s.getState().solarPlaying, false);
    s.getState().toggleSolarPlaying();
    assert.strictEqual(s.getState().solarPlaying, true);
    s.getState().toggleSolarPlaying();
    assert.strictEqual(s.getState().solarPlaying, false);
  });
});
