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
