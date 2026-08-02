/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { CoordinateInfo } from '@ifc-lite/geometry';
import {
  BAKED_MIN_Z_THRESHOLD_METERS,
  NEAR_ZERO_ORTHOGONAL_HEIGHT_METERS,
  modelMinZMeters,
  shouldSuggestAbsoluteAltitude,
  suggestAbsoluteAltitudeForKmz,
} from './kmz-altitude-hint.js';

/** CoordinateInfo with the required fields defaulted to identity. */
function coordInfo(overrides: Partial<CoordinateInfo> = {}): CoordinateInfo {
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
    hasLargeCoordinates: false,
    ...overrides,
  };
}

describe('shouldSuggestAbsoluteAltitude', () => {
  it('fires for a baked-MSL model: high min Z, no conversion elevation', () => {
    // Swiss LN02 site around 500 m, OrthogonalHeight left at 0.
    assert.strictEqual(shouldSuggestAbsoluteAltitude(500, 0), true);
  });

  it('is inclusive at the min-Z threshold and exclusive just below', () => {
    assert.strictEqual(shouldSuggestAbsoluteAltitude(BAKED_MIN_Z_THRESHOLD_METERS, 0), true);
    assert.strictEqual(shouldSuggestAbsoluteAltitude(BAKED_MIN_Z_THRESHOLD_METERS - 0.001, 0), false);
  });

  it('is exclusive at the orthogonal-height threshold, either sign', () => {
    assert.strictEqual(shouldSuggestAbsoluteAltitude(500, NEAR_ZERO_ORTHOGONAL_HEIGHT_METERS), false);
    assert.strictEqual(shouldSuggestAbsoluteAltitude(500, -NEAR_ZERO_ORTHOGONAL_HEIGHT_METERS), false);
    assert.strictEqual(shouldSuggestAbsoluteAltitude(500, NEAR_ZERO_ORTHOGONAL_HEIGHT_METERS - 0.001), true);
    assert.strictEqual(shouldSuggestAbsoluteAltitude(500, -(NEAR_ZERO_ORTHOGONAL_HEIGHT_METERS - 0.001)), true);
  });

  it('stays quiet for local-datum models (min Z near project zero)', () => {
    assert.strictEqual(shouldSuggestAbsoluteAltitude(0, 0), false);
    assert.strictEqual(shouldSuggestAbsoluteAltitude(-3.5, 0), false); // basement below zero
  });

  it('stays quiet when the conversion already carries the elevation', () => {
    // OrthogonalHeight = 500: "True elevation" is a user choice, not a fix.
    assert.strictEqual(shouldSuggestAbsoluteAltitude(500, 500), false);
  });

  it('rejects missing or non-finite inputs defensively', () => {
    assert.strictEqual(shouldSuggestAbsoluteAltitude(null, 0), false);
    assert.strictEqual(shouldSuggestAbsoluteAltitude(undefined, 0), false);
    assert.strictEqual(shouldSuggestAbsoluteAltitude(NaN, 0), false);
    assert.strictEqual(shouldSuggestAbsoluteAltitude(Infinity, 0), false);
    assert.strictEqual(shouldSuggestAbsoluteAltitude(500, NaN), false);
  });
});

describe('modelMinZMeters', () => {
  it('reads the vertical minimum from the Y-up bounds', () => {
    const info = coordInfo({
      originalBounds: { min: { x: -5, y: 512.25, z: -5 }, max: { x: 5, y: 530, z: 5 } },
    });
    assert.strictEqual(modelMinZMeters(info), 512.25);
  });

  it('folds the origin shift back in', () => {
    const info = coordInfo({
      originalBounds: { min: { x: 0, y: 12.25, z: 0 }, max: { x: 5, y: 30, z: 5 } },
      originShift: { x: 100, y: 500, z: -20 },
    });
    assert.strictEqual(modelMinZMeters(info), 512.25);
  });

  it('folds the wasm RTC offset back in (Z-up z is the vertical component)', () => {
    // RTC rebase moved the geometry near the origin; the baked elevation lives
    // in wasmRtcOffset.z (IFC Z-up), not in the bounds.
    const info = coordInfo({
      originalBounds: { min: { x: 0, y: 2, z: 0 }, max: { x: 5, y: 20, z: 5 } },
      wasmRtcOffset: { x: 2600000, y: 1200000, z: 498 },
      hasLargeCoordinates: true,
    });
    assert.strictEqual(modelMinZMeters(info), 500);
  });

  it('returns null without coordinate info or with non-finite bounds', () => {
    assert.strictEqual(modelMinZMeters(undefined), null);
    const bad = coordInfo({
      originalBounds: { min: { x: 0, y: NaN, z: 0 }, max: { x: 5, y: 20, z: 5 } },
    });
    assert.strictEqual(modelMinZMeters(bad), null);
  });
});

describe('suggestAbsoluteAltitudeForKmz', () => {
  const highInfo = coordInfo({
    originalBounds: { min: { x: 0, y: 512, z: 0 }, max: { x: 5, y: 530, z: 5 } },
  });

  it('fires for baked-Z geometry with a zero-height conversion', () => {
    assert.strictEqual(
      suggestAbsoluteAltitudeForKmz(highInfo, { orthogonalHeight: 0 }, undefined, 1),
      true,
    );
  });

  it('scales OrthogonalHeight from map units: 200 mm is still near zero', () => {
    // Raw 200 >= 1, but with a millimetre map unit it is 0.2 m.
    assert.strictEqual(
      suggestAbsoluteAltitudeForKmz(highInfo, { orthogonalHeight: 200 }, { mapUnitScale: 0.001 }, 0.001),
      true,
    );
  });

  it('scales OrthogonalHeight from map units: 500000 mm carries the elevation', () => {
    assert.strictEqual(
      suggestAbsoluteAltitudeForKmz(highInfo, { orthogonalHeight: 500000 }, { mapUnitScale: 0.001 }, 0.001),
      false,
    );
  });

  it('folds the RTC offset before judging "implausibly high"', () => {
    const rtcInfo = coordInfo({
      originalBounds: { min: { x: 0, y: 2, z: 0 }, max: { x: 5, y: 20, z: 5 } },
      wasmRtcOffset: { x: 2600000, y: 1200000, z: 498 },
      hasLargeCoordinates: true,
    });
    assert.strictEqual(
      suggestAbsoluteAltitudeForKmz(rtcInfo, { orthogonalHeight: 0 }, undefined, 1),
      true,
    );
  });

  it('stays quiet without a conversion or for low geometry', () => {
    assert.strictEqual(suggestAbsoluteAltitudeForKmz(highInfo, undefined, undefined, 1), false);
    const lowInfo = coordInfo();
    assert.strictEqual(
      suggestAbsoluteAltitudeForKmz(lowInfo, { orthogonalHeight: 0 }, undefined, 1),
      false,
    );
  });
});
