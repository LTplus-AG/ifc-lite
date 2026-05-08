/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { findClampAnchorY } from './clamp-anchor.js';

describe('findClampAnchorY', () => {
  const buildingBounds = { min: { y: -3.5 }, max: { y: 50 } }; // basement at -3.5m, top at 50m

  it('falls back to bounds.min.y when no storeys are present', () => {
    assert.strictEqual(findClampAnchorY(buildingBounds, undefined), -3.5);
    assert.strictEqual(findClampAnchorY(buildingBounds, new Map()), -3.5);
  });

  it('falls back to bounds.min.y when bounds are missing', () => {
    const storeys = new Map([[1, 0], [2, 3]]);
    assert.strictEqual(findClampAnchorY(undefined, storeys), 0);
  });

  it('picks the storey closest to elevation 0 (ground floor)', () => {
    const storeys = new Map([
      [1, -3.0],   // basement
      [2, 0.0],    // ground floor — closest to 0
      [3, 3.5],    // 1st floor
      [4, 7.0],    // 2nd floor
    ]);
    assert.strictEqual(findClampAnchorY(buildingBounds, storeys), 0.0);
  });

  it('handles a model authored with a non-zero ground (e.g. 0.15m above origin)', () => {
    const storeys = new Map([
      [1, -3.0],
      [2, 0.15],   // ground floor — closest to 0
      [3, 3.65],
    ]);
    assert.strictEqual(findClampAnchorY(buildingBounds, storeys), 0.15);
  });

  it('ignores storeys outside the model bounds (avoid stray site-only markers)', () => {
    // A "Site" or "External" storey with elevation way outside the actual
    // building extents shouldn't lift the clamp out into mid-air.
    const storeys = new Map([
      [1, -3.0],
      [2, 200],    // out of bounds — site marker, must be skipped
      [3, 5.0],
    ]);
    // Within bounds: -3.0 (|3|) and 5.0 (|5|). −3.0 is closer to 0.
    assert.strictEqual(findClampAnchorY(buildingBounds, storeys), -3.0);
  });

  it('uses the lowest storey if all are below 0 (basement-level model)', () => {
    const bounds = { min: { y: -10 }, max: { y: -1 } };
    const storeys = new Map([[1, -8], [2, -3]]);
    // -3 is closer to 0 than -8
    assert.strictEqual(findClampAnchorY(bounds, storeys), -3);
  });

  it('handles negative-only storeys without crashing', () => {
    const bounds = { min: { y: -100 }, max: { y: 0 } };
    const storeys = new Map([[1, -50], [2, -20]]);
    assert.strictEqual(findClampAnchorY(bounds, storeys), -20);
  });

  it('skips non-finite elevations defensively', () => {
    const storeys = new Map([
      [1, NaN],
      [2, Infinity],
      [3, 2.0],
    ]);
    assert.strictEqual(findClampAnchorY(buildingBounds, storeys), 2.0);
  });

  it('falls back to bounds.min.y when every storey is out of range', () => {
    const storeys = new Map([[1, 1000], [2, -1000]]);
    assert.strictEqual(findClampAnchorY(buildingBounds, storeys), -3.5);
  });
});
