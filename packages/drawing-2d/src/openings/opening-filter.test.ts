/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { OpeningFilter } from './opening-filter.js';
import type { CutSegment, OpeningInfo, OpeningRelationships } from '../types.js';

const HOST_ID = 10;
const OPENING_ID = 20;

function makeRelationships(): OpeningRelationships {
  const openingInfo: OpeningInfo = {
    type: 'opening',
    openingId: OPENING_ID,
    hostElementId: HOST_ID,
    width: 2,
    height: 2,
    // Axis 'z', not flipped -> 2D x/y maps directly to 3D x/y.
    bounds3D: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 4, y: 4, z: 1 },
    },
    modelIndex: 0,
  };
  return {
    voidedBy: new Map([[HOST_ID, [OPENING_ID]]]),
    filledBy: new Map(),
    openingInfo: new Map([[OPENING_ID, openingInfo]]),
  };
}

function makeSegment(p0: { x: number; y: number }, p1: { x: number; y: number }): CutSegment {
  return {
    p0: { x: p0.x, y: p0.y, z: 0 },
    p1: { x: p1.x, y: p1.y, z: 0 },
    p0_2d: p0,
    p1_2d: p1,
    entityId: HOST_ID,
    ifcType: 'IfcWall',
    modelIndex: 0,
  };
}

describe('OpeningFilter.filterSegment (void removal)', () => {
  it('removes a cut segment that lies entirely inside an opening void', () => {
    const filter = new OpeningFilter(makeRelationships());
    filter.projectOpenings({ axis: 'z', position: 0, flipped: false });

    // Fully inside the [0,0]-[4,4] opening bounds.
    const segment = makeSegment({ x: 1, y: 1 }, { x: 3, y: 3 });
    const result = filter.filterSegmentsForHost([segment], HOST_ID);

    expect(result).toEqual([]);
  });

  it('keeps a cut segment entirely outside the opening void', () => {
    const filter = new OpeningFilter(makeRelationships());
    filter.projectOpenings({ axis: 'z', position: 0, flipped: false });

    // Well clear of the [0,0]-[4,4] opening bounds.
    const segment = makeSegment({ x: 10, y: 10 }, { x: 12, y: 12 });
    const result = filter.filterSegmentsForHost([segment], HOST_ID);

    expect(result).toEqual([segment]);
  });
});

describe('OpeningFilter.filterSegment (straddling void — splitSegmentAtOpening)', () => {
  // Void bounds are the axis-aligned [0,0]-[4,4] box from makeRelationships().
  // Every wall segment below is diagonal (dx !== dy, neither dx nor dy is 0)
  // so that a swapped x/y axis inside the split logic would show up as a
  // wrong coordinate, not just a wrong count.

  it('starts outside, ends inside the void: keeps only the outside part, cut exactly at the boundary', () => {
    const filter = new OpeningFilter(makeRelationships());
    filter.projectOpenings({ axis: 'z', position: 0, flipped: false });

    // p0=(-2,1) outside (x<0); p1=(2,2) inside the void.
    // Line: x = -2 + 4t, y = 1 + t. Crosses the left edge x=0 at t=0.5 -> (0, 1.5).
    const segment = makeSegment({ x: -2, y: 1 }, { x: 2, y: 2 });
    const result = filter.filterSegmentsForHost([segment], HOST_ID);

    expect(result).toHaveLength(1);
    expect(result[0].p0_2d).toEqual({ x: -2, y: 1 });
    expect(result[0].p1_2d).toEqual({ x: 0, y: 1.5 });
  });

  it('starts inside, ends outside the void (mirror case): keeps only the outside part, cut at the opposite edge', () => {
    const filter = new OpeningFilter(makeRelationships());
    filter.projectOpenings({ axis: 'z', position: 0, flipped: false });

    // p0=(2,2) inside the void; p1=(6,3) outside (x>4).
    // Line: x = 2 + 4t, y = 2 + t. Crosses the right edge x=4 at t=0.5 -> (4, 2.5).
    const segment = makeSegment({ x: 2, y: 2 }, { x: 6, y: 3 });
    const result = filter.filterSegmentsForHost([segment], HOST_ID);

    expect(result).toHaveLength(1);
    expect(result[0].p0_2d).toEqual({ x: 4, y: 2.5 });
    expect(result[0].p1_2d).toEqual({ x: 6, y: 3 });
  });

  it('spans the whole void (starts and ends outside): keeps both outside parts with correct endpoints', () => {
    const filter = new OpeningFilter(makeRelationships());
    filter.projectOpenings({ axis: 'z', position: 0, flipped: false });

    // p0=(-2,1) outside (x<0); p1=(6,3) outside (x>4).
    // Line: x = -2 + 8t, y = 1 + 2t.
    // Crosses left edge x=0 at t=0.25 -> (0, 1.5); crosses right edge x=4 at t=0.75 -> (4, 2.5).
    const segment = makeSegment({ x: -2, y: 1 }, { x: 6, y: 3 });
    const result = filter.filterSegmentsForHost([segment], HOST_ID);

    expect(result).toHaveLength(2);
    expect(result[0].p0_2d).toEqual({ x: -2, y: 1 });
    expect(result[0].p1_2d).toEqual({ x: 0, y: 1.5 });
    expect(result[1].p0_2d).toEqual({ x: 4, y: 2.5 });
    expect(result[1].p1_2d).toEqual({ x: 6, y: 3 });
  });

  it('starts exactly flush with a void edge: the boundary point counts as inside, so only the exterior tail survives', () => {
    const filter = new OpeningFilter(makeRelationships());
    filter.projectOpenings({ axis: 'z', position: 0, flipped: false });

    // p0=(0,1) sits exactly on the void's left edge (x=0); p1=(8,5) is well outside (x>4).
    // Line: x = 8t, y = 1 + 4t. Crosses the right edge x=4 at t=0.5 -> (4, 3).
    // pointInBounds treats x=0 as inside (inclusive boundary), so the piece from
    // p0 to the right-edge crossing lies inside the void and must be dropped;
    // only the tail from (4,3) to p1 survives.
    const segment = makeSegment({ x: 0, y: 1 }, { x: 8, y: 5 });
    const result = filter.filterSegmentsForHost([segment], HOST_ID);

    expect(result).toHaveLength(1);
    expect(result[0].p0_2d).toEqual({ x: 4, y: 3 });
    expect(result[0].p1_2d).toEqual({ x: 8, y: 5 });
  });
});
