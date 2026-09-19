/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rectangleOfCurve } from './rectangle-profile.mjs';

test('an explicit IfcLineIndex rectangle uses a vertex walk, closed or open', () => {
  const pointList = { type: 'IFCCARTESIANPOINTLIST2D', args: '((0,0),(4,0),(4,2),(0,2))' };
  for (const segments of ['((IFCLINEINDEX((1,2,3,4,1))))', '((IFCLINEINDEX((1,2,3,4))))']) {
    const index = { byId: new Map([
      [1, pointList],
      [2, { type: 'IFCINDEXEDPOLYCURVE', args: `#1,${segments},$` }],
    ]) };
    assert.deepEqual(rectangleOfCurve(index, 2)?.centre, [2, 1]);
  }
});

test('an explicit IfcLineIndex rectangle accepts one connected segment per edge (#5005 review)', () => {
  const pointList = { type: 'IFCCARTESIANPOINTLIST2D', args: '((0,0),(4,0),(4,2),(0,2))' };
  const segments = '((IFCLINEINDEX((1,2)),IFCLINEINDEX((2,3)),IFCLINEINDEX((3,4)),IFCLINEINDEX((4,1))))';
  const index = { byId: new Map([
    [1, pointList],
    [2, { type: 'IFCINDEXEDPOLYCURVE', args: `#1,${segments},$` }],
  ]) };

  assert.deepEqual(rectangleOfCurve(index, 2)?.centre, [2, 1]);
});

test('an explicit IfcLineIndex rectangle rejects disconnected segments', () => {
  const pointList = { type: 'IFCCARTESIANPOINTLIST2D', args: '((0,0),(4,0),(4,2),(0,2))' };
  const segments = '((IFCLINEINDEX((1,2)),IFCLINEINDEX((3,4)),IFCLINEINDEX((4,1))))';
  const index = { byId: new Map([
    [1, pointList],
    [2, { type: 'IFCINDEXEDPOLYCURVE', args: `#1,${segments},$` }],
  ]) };

  assert.equal(rectangleOfCurve(index, 2), undefined);
});
