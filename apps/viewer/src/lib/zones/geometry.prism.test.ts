/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The zone-shape seam (#2508 item 4): `compileZone`, the point test, the
 * overlap test and the corner list all have to answer for a PRISM as well as a
 * box, and each of them is consumed by something different (assignment, the
 * apportionment prefilter, the 3D overlay).
 *
 * Kept out of `geometry.test.ts` because that file pins v1's box behaviour and
 * these are the questions v1 could not be asked.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { compileZone, isPointInCompiledZone, zoneOverlapsAABBCompiled, zoneWorldCorners } from './geometry.js';
import type { Zone } from './types.js';

/** A triangular takt area over the lower-left half of a 10 x 10 plan, 3 m tall
 *  from y = 0. Its bounding box is the whole 10 x 10. */
const PRISM: Zone = {
  id: 'p',
  name: 'Takt triangle',
  center: [5, 1.5, 5],
  size: [10, 3, 10],
  rotationY: 0,
  footprint: [[0, 0], [10, 0], [0, 10]],
};

describe('compiled prism zones', () => {
  it('contains a point inside the polygon and not one merely inside the box', () => {
    const compiled = compileZone(PRISM);
    assert.equal(isPointInCompiledZone(1, 1.5, 1, compiled), true);
    // Inside the bounding box, past the diagonal.
    assert.equal(isPointInCompiledZone(9, 1.5, 9, compiled), false);
  });

  it('still applies the vertical extent, which the footprint says nothing about', () => {
    const compiled = compileZone(PRISM);
    assert.equal(isPointInCompiledZone(1, 10, 1, compiled), false);
  });

  it('overlaps an AABB by the polygon rather than by the bounding box', () => {
    const compiled = compileZone(PRISM);
    assert.equal(zoneOverlapsAABBCompiled(0.5, 0, 0.5, 1.5, 1, 1.5, compiled), true);
    assert.equal(zoneOverlapsAABBCompiled(8, 0, 8, 9.5, 1, 9.5, compiled), false);
  });

  it('ignores rotationY, which a prism does not own', () => {
    // The footprint is already in world coordinates. A compiled prism that
    // rotated it would move a zone the user cannot see rotating.
    const spun = compileZone({ ...PRISM, rotationY: Math.PI / 3 });
    assert.equal(isPointInCompiledZone(1, 1.5, 1, spun), true);
    assert.equal(isPointInCompiledZone(9, 1.5, 9, spun), false);
  });

  it('returns one corner per footprint point per level, for the overlay', () => {
    // The 3D overlay derives its wireframe edges from this list's LENGTH since
    // #2508 item 4. Eight corners for a box, 2n for a prism.
    const corners = zoneWorldCorners(PRISM);
    assert.equal(corners.length, 6);
    assert.deepEqual(corners[0], [0, 0, 0], 'bottom ring first, at the base');
    assert.deepEqual(corners[3], [0, 3, 0], 'top ring second, at the top');
    assert.equal(zoneWorldCorners({ ...PRISM, footprint: undefined }).length, 8);
  });
});
