/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BAKE_HEIGHT, floorToFloorHeight } from './floor-height.js';

const STOREYS = [
  { id: 10, elev: 0 },
  { id: 20, elev: 3.2 },
  { id: 30, elev: 6.4 },
];

describe('floorToFloorHeight', () => {
  it('measures the gap to the storey above', () => {
    assert.equal(floorToFloorHeight(STOREYS, 10), 3.2);
    assert.ok(Math.abs(floorToFloorHeight(STOREYS, 20) - 3.2) < 1e-9);
  });

  it('falls back for the top storey, which has nothing above it', () => {
    assert.equal(floorToFloorHeight(STOREYS, 30), BAKE_HEIGHT);
  });

  it('falls back for a storey that is not in the list', () => {
    assert.equal(floorToFloorHeight(STOREYS, 999), BAKE_HEIGHT);
    assert.equal(floorToFloorHeight([], 10), BAKE_HEIGHT);
  });

  it('refuses a zero or negative gap', () => {
    // Two storeys exported at the same elevation is common. Taking the gap
    // literally gives a zero-height band, and `wallRectsFromMeshes` then finds
    // no walls at all — the plan comes up empty with no error to explain it.
    const flat = [{ id: 1, elev: 4 }, { id: 2, elev: 4 }, { id: 3, elev: 2 }];
    assert.equal(floorToFloorHeight(flat, 1), BAKE_HEIGHT, 'zero gap');
    assert.equal(floorToFloorHeight(flat, 2), BAKE_HEIGHT, 'negative gap (unsorted list)');
  });

  it('refuses a gap far too large to be a storey height', () => {
    // A storey elevation left in millimetres reads as kilometres of gap, which
    // would sweep the entire building into one storey's plan.
    const mm = [{ id: 1, elev: 0 }, { id: 2, elev: 3200 }];
    assert.equal(floorToFloorHeight(mm, 1), BAKE_HEIGHT);
  });

  it('keeps a low but plausible storey height', () => {
    const low = [{ id: 1, elev: 0 }, { id: 2, elev: 2.2 }];
    assert.equal(floorToFloorHeight(low, 1), 2.2);
  });
});
