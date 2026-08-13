/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pt } from '@/lib/space-sketch-geometry.js';
import { BAKE_HEIGHT, floorToFloorHeight, planStoreySpaces, type DraftRoom } from './space-bake.js';

const STOREYS = [
  { id: 10, elev: 0 },
  { id: 20, elev: 3.2 },
  { id: 30, elev: 6.4 },
];

/** A `size`×`size` square with its lower-left corner at `(x, y)`. */
function square(x: number, y: number, size: number): Pt[] {
  return [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];
}

/** A draft room whose emit boundary is inset from its centreline outline. */
function room(outline: Pt[], boundary: Pt[] = outline): DraftRoom {
  return { outline, boundary };
}

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

describe('planStoreySpaces', () => {
  it('plans one space per room at the storey height', () => {
    const rooms = [room(square(0, 0, 4)), room(square(10, 0, 2))];
    const { planned, skipped } = planStoreySpaces(rooms, [], 3.2);
    assert.equal(skipped, 0);
    assert.deepEqual(planned.map((p) => p.Height), [3.2, 3.2]);
  });

  it('emits the BOUNDARY outline but measures area on the CENTRELINE', () => {
    // The user's net/gross choice changes the profile that lands in the file;
    // the quantity must still describe the room, not the wall face. Emitting
    // the boundary while measuring the boundary would make gross area shrink
    // whenever the user switched to "inner".
    const outline = square(0, 0, 4);       // 16 m² on the centreline
    const boundary = square(0.1, 0.1, 3.8); // the inset net face
    const { planned } = planStoreySpaces([room(outline, boundary)], [], 3);
    assert.deepEqual(planned[0].OuterCurve, boundary, 'the inset face is what gets created');
    assert.equal(planned[0].grossFloorArea, 16, 'the area stays on the centreline');
  });

  it('skips a room whose centroid sits inside an already-authored space', () => {
    // The tool derives rooms from walls, so on a model that already has spaces
    // every one of them would otherwise be authored a second time.
    const authored = [square(0, 0, 4)];
    const rooms = [room(square(0, 0, 4)), room(square(10, 0, 2))];
    const { planned, skipped } = planStoreySpaces(rooms, authored, 3);
    assert.equal(skipped, 1);
    assert.equal(planned.length, 1);
    assert.equal(planned[0].grossFloorArea, 4, 'the surviving room is the far one');
  });

  it('does not skip a room that merely touches an authored footprint', () => {
    // Dedup is by centroid containment, not by overlap: two rooms sharing a
    // wall with an authored space must both still be created.
    const authored = [square(0, 0, 4)];
    const { planned, skipped } = planStoreySpaces([room(square(4, 0, 4))], authored, 3);
    assert.equal(skipped, 0);
    assert.equal(planned.length, 1);
  });

  it('plans nothing from no rooms', () => {
    assert.deepEqual(planStoreySpaces([], [square(0, 0, 1)], 3), { planned: [], skipped: 0 });
  });
});
