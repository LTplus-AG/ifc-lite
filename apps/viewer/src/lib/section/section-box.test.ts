/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The section box's geometry (#5513): a box from bounds, one face moved
 * without crossing its opposite, and the face centres / corners / normals
 * the gizmo draws from — all asserted as numbers against a [0,10] x
 * [-1,3] x [0,8] box.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_SECTION_BOX_SIZE_M,
  SECTION_BOX_FACES,
  moveSectionBoxFace,
  sectionBoxFaceCenter,
  sectionBoxFaceCorners,
  sectionBoxFaceNormal,
  sectionBoxFromBounds,
  sectionBoxSize,
} from './section-box.js';

const box = () => ({ min: [0, -1, 0] as [number, number, number], max: [10, 3, 8] as [number, number, number] });

describe('sectionBoxFromBounds', () => {
  it('copies finite, non-degenerate bounds into tuples', () => {
    assert.deepEqual(sectionBoxFromBounds({ min: { x: 0, y: -1, z: 0 }, max: { x: 10, y: 3, z: 8 } }), box());
  });
  it('rejects nothing, a non-finite corner, and a box thinner than the minimum on any axis', () => {
    assert.equal(sectionBoxFromBounds(null), null);
    assert.equal(sectionBoxFromBounds({ min: { x: 0, y: -1, z: 0 }, max: { x: Infinity, y: 3, z: 8 } }), null);
    assert.equal(sectionBoxFromBounds({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: MIN_SECTION_BOX_SIZE_M / 2, z: 8 } }), null);
  });
});

describe('moveSectionBoxFace', () => {
  it('moves only the named face, on its own axis', () => {
    assert.deepEqual(moveSectionBoxFace(box(), 'maxY', 2), { min: [0, -1, 0], max: [10, 2, 8] });
    assert.deepEqual(moveSectionBoxFace(box(), 'minZ', 1.5), { min: [0, -1, 1.5], max: [10, 3, 8] });
  });
  it('stops a face at the minimum thickness short of its opposite, from both sides', () => {
    assert.deepEqual(moveSectionBoxFace(box(), 'minX', 25).min[0], 10 - MIN_SECTION_BOX_SIZE_M);
    assert.deepEqual(moveSectionBoxFace(box(), 'maxX', -25).max[0], 0 + MIN_SECTION_BOX_SIZE_M);
  });
  it('ignores a non-finite value and returns the same box', () => {
    const b = box();
    assert.equal(moveSectionBoxFace(b, 'maxX', NaN), b);
  });
});

describe('face geometry', () => {
  it('sizes the box along each axis', () => {
    assert.deepEqual(sectionBoxSize(box()), [10, 4, 8]);
  });
  it('centres each face on the box and points its normal outward', () => {
    assert.deepEqual(sectionBoxFaceCenter(box(), 'maxX'), [10, 1, 4]);
    assert.deepEqual(sectionBoxFaceCenter(box(), 'minY'), [5, -1, 4]);
    assert.deepEqual(sectionBoxFaceNormal('minY'), [0, -1, 0]);
    assert.deepEqual(sectionBoxFaceNormal('maxZ'), [0, 0, 1]);
  });
  it('gives every face four corners on that face, each a corner of the box', () => {
    for (const face of SECTION_BOX_FACES) {
      const corners = sectionBoxFaceCorners(box(), face);
      assert.equal(corners.length, 4);
      const fixed = sectionBoxFaceCenter(box(), face);
      const axis = face.endsWith('X') ? 0 : face.endsWith('Y') ? 1 : 2;
      for (const c of corners) {
        assert.equal(c[axis], fixed[axis], `${face}: corner lies on the face`);
        for (let i = 0; i < 3; i++) assert.ok(c[i] === box().min[i] || c[i] === box().max[i], `${face}: a box corner`);
      }
      assert.equal(new Set(corners.map((c) => c.join(','))).size, 4, `${face}: four distinct corners`);
    }
  });
});
