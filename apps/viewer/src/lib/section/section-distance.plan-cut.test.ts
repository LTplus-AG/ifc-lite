/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A plan cut above the model top (#8162): floor + 1.2 m is kept when it clears
 * the bounds, instead of being clamped onto the top face. `worldToPosition` is
 * the exact inverse of `percentToWorld`; `worldToPercent` stays the clamped
 * variant the distance control commits through.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STOREY_IN_RANGE_TOLERANCE_M,
  clampSectionPercent,
  percentToWorld,
  restoredCutPosition,
  storeyCutPosition,
  worldToPercent,
  worldToPosition,
} from './section-distance.js';

const close = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} expected ${expected}, got ${actual}`);

describe('worldToPosition (#8162)', () => {
  const range = { min: -1, max: 3 };

  it('is the unclamped inverse of percentToWorld, above, inside and below the range', () => {
    for (const world of [-7.5, -1, 0.3, 3, 3.7, 12]) {
      close(percentToWorld(worldToPosition(world, range), range), world, `world ${world}:`);
    }
    close(worldToPosition(4, range), 125);
    close(worldToPosition(-2, range), -25);
  });

  it('worldToPercent stays its clamped variant', () => {
    assert.equal(worldToPercent(4, range), 100);
    assert.equal(worldToPercent(-2, range), 0);
    close(worldToPercent(1, range), 50);
  });

  it('clampSectionPercent keeps the bounded inputs\' coercion, Infinity included', () => {
    assert.equal(clampSectionPercent(150), 100);
    assert.equal(clampSectionPercent(-10), 0);
    assert.equal(clampSectionPercent(42), 42);
    assert.equal(clampSectionPercent(NaN), 0);
    assert.equal(clampSectionPercent(Infinity), 100);
    assert.equal(clampSectionPercent(-Infinity), 0);
  });
});

describe('storeyCutPosition (#8162)', () => {
  const range = { min: 0, max: 3 };

  it('top storey at 2.5 m under a 3.0 m top: the cut resolves to 3.7 m, past 100 %', () => {
    const position = storeyCutPosition({ elevation: 2.5 }, range);
    assert.ok(position > 100, `position ${position} must exceed 100`);
    close(percentToWorld(position, range), 3.7);
  });

  it('an in-range cut is unchanged', () => {
    close(storeyCutPosition({ elevation: 0 }, range), 40);
    close(percentToWorld(storeyCutPosition({ elevation: 1 }, range), range), 2.2);
  });

  it('a floor outside the range keeps the clamped fallback (raw elevations and shifted bounds may disagree)', () => {
    assert.equal(storeyCutPosition({ elevation: 10 }, range), 100);
    assert.equal(storeyCutPosition({ elevation: 3.5 }, range), 100);
    assert.equal(storeyCutPosition({ elevation: -5 }, range), 0);
  });

  it('a floor within the tolerance of the range ends still extrapolates; one just past it does not', () => {
    const within = range.max + STOREY_IN_RANGE_TOLERANCE_M / 2;
    close(percentToWorld(storeyCutPosition({ elevation: within }, range), range), within + 1.2);
    const beyond = range.max + STOREY_IN_RANGE_TOLERANCE_M * 2;
    assert.equal(storeyCutPosition({ elevation: beyond }, range), 100);
    // At the bottom: a floor a hair below the range, cut 1.2 m up, inside the range either way.
    close(percentToWorld(storeyCutPosition({ elevation: -STOREY_IN_RANGE_TOLERANCE_M / 2 }, range), range), 1.2 - STOREY_IN_RANGE_TOLERANCE_M / 2);
  });
});

describe('restoredCutPosition (#8162)', () => {
  it('a saved cut above or below the bounds comes back there', () => {
    close(restoredCutPosition(12, 0, 10), 120);
    close(restoredCutPosition(-2, 0, 10), -20);
    close(restoredCutPosition(8, 0, 10), 80);
  });

  it('a degenerate span or non-finite input restores the centre', () => {
    assert.equal(restoredCutPosition(5, 5, 5), 50);
    assert.equal(restoredCutPosition(NaN, 0, 10), 50);
    assert.equal(restoredCutPosition(Infinity, 0, 10), 50);
  });
});
