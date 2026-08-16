/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { polylineOpenLength, polylineLength, polylineBasisLabel } from './polyline.js';

describe('polylineOpenLength', () => {
  it('sums consecutive segment lengths', () => {
    // A 3-4-5 triangle path: (0,0,0) -> (3,0,0) -> (3,4,0). 3 + 4 = 7.
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 },
      { x: 3, y: 4, z: 0 },
    ];
    assert.equal(polylineOpenLength(points), 7);
  });

  it('is zero for fewer than two points', () => {
    assert.equal(polylineOpenLength([]), 0);
    assert.equal(polylineOpenLength([{ x: 1, y: 1, z: 1 }]), 0);
  });
});

describe('polylineLength', () => {
  it('open: equals the open sum, no closing segment', () => {
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 },
      { x: 3, y: 4, z: 0 },
    ];
    assert.equal(polylineLength(points, false), 7);
  });

  it('closed: adds the segment back to the first point (perimeter)', () => {
    // Right triangle: legs 3 and 4, hypotenuse (closing segment) 5.
    // Open length 3 + 4 = 7; perimeter 7 + 5 = 12.
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 },
      { x: 3, y: 4, z: 0 },
    ];
    assert.equal(polylineLength(points, true), 12);
  });

  it('closed vs open on the SAME points give different numbers', () => {
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 },
      { x: 3, y: 4, z: 0 },
    ];
    const open = polylineLength(points, false);
    const closed = polylineLength(points, true);
    assert.notEqual(open, closed);
    assert.equal(closed, open + 5); // the closing segment
  });

  it('closed with fewer than 2 points does not add a closing segment', () => {
    assert.equal(polylineLength([{ x: 0, y: 0, z: 0 }], true), 0);
    assert.equal(polylineLength([], true), 0);
  });
});

describe('polylineBasisLabel', () => {
  it('names the basis explicitly rather than leaving it implicit', () => {
    assert.equal(polylineBasisLabel(false), 'Length');
    assert.equal(polylineBasisLabel(true), 'Perimeter (closed)');
    assert.notEqual(polylineBasisLabel(false), polylineBasisLabel(true));
  });
});
