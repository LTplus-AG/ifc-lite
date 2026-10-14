/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldSegment } from '@ifc-lite/drawing-2d';
import { clipSegmentsToHalfSpace } from './clip-rim-segments';

const seg = (sx: number, ex: number): WorldSegment => ({
  start: { x: sx, y: 0, z: 0 }, end: { x: ex, y: 0, z: 0 }, entityId: 7, ifcType: 'IfcWall', modelIndex: 0,
});
const NORMAL = { x: 1, y: 0, z: 0 };

describe('rim segments against a later cutting plane (#7545)', () => {
  it('keeps a segment wholly on the kept side, untouched', () => {
    const s = seg(0, 2);
    assert.deepEqual(clipSegmentsToHalfSpace([s], NORMAL, 5), [s]);
  });

  it('drops a segment wholly on the removed side', () => {
    assert.deepEqual(clipSegmentsToHalfSpace([seg(6, 9)], NORMAL, 5), []);
  });

  it('cuts a crossing segment at the plane, whichever end is kept, and keeps its element', () => {
    const [forward] = clipSegmentsToHalfSpace([seg(2, 8)], NORMAL, 5);
    assert.deepEqual([forward.start.x, forward.end.x], [2, 5]);
    const [backward] = clipSegmentsToHalfSpace([seg(8, 2)], NORMAL, 5);
    assert.deepEqual([backward.start.x, backward.end.x], [5, 2]);
    assert.equal(forward.entityId, 7);
    assert.equal(forward.ifcType, 'IfcWall');
  });

  it('keeps a segment lying on the plane', () => {
    assert.equal(clipSegmentsToHalfSpace([seg(5, 5)], NORMAL, 5).length, 1);
  });
});
