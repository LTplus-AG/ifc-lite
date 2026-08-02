/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { CoordinateInfo } from '@ifc-lite/geometry';

import { computeKmzAltitude } from './kmz-export.js';

describe('computeKmzAltitude', () => {
  it('scales OrthogonalHeight from map units to metres (mm-CRS file is not 1000x off)', () => {
    // OrthogonalHeight authored as 500000 mm with a mm map unit = 500 m MSL.
    assert.strictEqual(computeKmzAltitude(500_000, { mapUnitScale: 0.001 }, 1, undefined), 500);
  });

  it('folds the wasm RTC Z offset back in (RTC-rebased models are not placed rtc.z too low)', () => {
    // The COLLADA exporter bakes post-RTC mesh Z; the KML altitude must restore it.
    const coordinateInfo = { wasmRtcOffset: { x: 0, y: 0, z: 417 } } as CoordinateInfo;
    assert.strictEqual(computeKmzAltitude(100, undefined, 1, coordinateInfo), 517);
  });

  it('defaults to 0 with no OrthogonalHeight, CRS, or coordinate info', () => {
    assert.strictEqual(computeKmzAltitude(undefined, undefined, 1, undefined), 0);
  });

  it('matches the pre-fix behaviour for the common metre-CRS, non-RTC model', () => {
    assert.strictEqual(computeKmzAltitude(455.5, { mapUnitScale: 1 }, 1, {} as CoordinateInfo), 455.5);
  });
});
