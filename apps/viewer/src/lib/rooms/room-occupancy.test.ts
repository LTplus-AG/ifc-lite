/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSimpleRing, occupancyTest } from './room-occupancy.js';
import type { Pt } from '@/lib/space-sketch-geometry';

describe('room occupancy (#6232 M4)', () => {
  it('tells a footprint ring from the vertex cloud a faceted IfcSpace footprint reads back as', () => {
    const ring: Pt[] = [[0, 0], [4, 0], [4, 3], [0, 3]];
    // The same corners in the order a triangulated body lists them (AC20's spaces).
    const cloud: Pt[] = [[0, 0], [4, 3], [4, 0], [0, 3]];
    assert.equal(isSimpleRing(ring), true);
    assert.equal(isSimpleRing(cloud), false);
    assert.equal(occupancyTest([ring], [])([2, 1.5]), true);
    // A crossed "ring" would claim or miss arbitrary points; it is left to the mesh triangles.
    assert.equal(occupancyTest([cloud], [])([2, 0.5]), false);
    assert.equal(occupancyTest([cloud], [[[0, 0], [4, 0], [4, 3]], [[0, 0], [4, 3], [0, 3]]])([2, 0.5]), true);
  });
});
