/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The world box that survives a section cut (#2042).
 *
 * DEFECT CLASS — an estimate that stops being an UPPER bound. The page readout
 * promises "the exported page will never be larger", and the oversize gate
 * refuses an export on the strength of it. Trim the box too little and the
 * gate blocks sheets that would print fine (the bug this module fixes); trim
 * it too much and the readout quietly under-quotes, which is the far worse
 * direction because the export then produces a page bigger than advertised and
 * possibly past the PDF limit.
 *
 * The tempting wrong implementation is "keep the corners on the inside", so
 * the oblique case below is the one that matters: a diagonal cut across a cube
 * can leave a surviving region that extends well beyond every surviving
 * corner, and only the edge-crossing points recover it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clipBoxToHalfSpace } from './clip-box-half-space.js';

const UNIT: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } = {
  min: { x: 0, y: 0, z: 0 },
  max: { x: 10, y: 10, z: 10 },
};

const CLOSE = 1e-9;

describe('clipBoxToHalfSpace (#2042)', () => {
  it('trims an axis-aligned cut exactly, leaving the other axes alone', () => {
    // Keep x <= 2.5 of a 10 m box: the estimate should now describe a 2.5 m
    // slab, not the whole 10 m. That difference is the entire point - at 1:10
    // the full box asks for 1000 mm of paper and the slab asks for 250 mm.
    const clipped = clipBoxToHalfSpace(UNIT, { x: 1, y: 0, z: 0 }, 2.5);
    assert.ok(clipped);
    assert.ok(Math.abs(clipped.min.x - 0) < CLOSE);
    assert.ok(Math.abs(clipped.max.x - 2.5) < CLOSE, `max.x ${clipped.max.x}`);
    assert.ok(Math.abs(clipped.min.y - 0) < CLOSE);
    assert.ok(Math.abs(clipped.max.y - 10) < CLOSE, 'a cut on X must not shrink Y');
    assert.ok(Math.abs(clipped.max.z - 10) < CLOSE, 'a cut on X must not shrink Z');
  });

  it('keeps the whole box when the plane misses it', () => {
    const clipped = clipBoxToHalfSpace(UNIT, { x: 1, y: 0, z: 0 }, 999);
    assert.ok(clipped);
    assert.deepEqual(clipped.min, UNIT.min);
    assert.deepEqual(clipped.max, UNIT.max);
  });

  it('reports nothing left when the cut removes the box entirely', () => {
    // Distinct from "unchanged": the caller must show no page at all, not a
    // page for geometry that is not there.
    assert.equal(clipBoxToHalfSpace(UNIT, { x: 1, y: 0, z: 0 }, -1), null);
  });

  it('stays an UPPER bound on an oblique cut, where surviving corners alone are not enough', () => {
    // Cut x + y <= 12 across a 10 m cube. Surviving corners have x, y in
    // {0, 10} with x + y <= 12, so their own box reaches only x = 10, y = 10 -
    // which happens to be the full extent here. The load-bearing part is that
    // the crossing points on the edges at x = 10 and y = 10 (at y = 2 and
    // x = 2) are inside that, so the result must still span the full 0..10 on
    // both axes rather than collapsing toward the surviving corners.
    const clipped = clipBoxToHalfSpace(UNIT, { x: 1, y: 1, z: 0 }, 12);
    assert.ok(clipped);
    assert.ok(Math.abs(clipped.min.x - 0) < CLOSE);
    assert.ok(Math.abs(clipped.max.x - 10) < CLOSE, `max.x ${clipped.max.x}`);
    assert.ok(Math.abs(clipped.max.y - 10) < CLOSE, `max.y ${clipped.max.y}`);
    assert.ok(Math.abs(clipped.max.z - 10) < CLOSE, 'z is untouched by an x/y cut');
  });

  it('recovers extent that lies BEYOND every surviving corner', () => {
    // The case that fails if edge crossings are dropped. Keep x + y <= 3:
    // the only surviving corners are the four at x = 0, y = 0, so a
    // corners-only implementation returns a degenerate box at the origin.
    // The true surviving region reaches x = 3 (at y = 0) and y = 3 (at x = 0).
    const clipped = clipBoxToHalfSpace(UNIT, { x: 1, y: 1, z: 0 }, 3);
    assert.ok(clipped);
    assert.ok(Math.abs(clipped.max.x - 3) < CLOSE, `max.x ${clipped.max.x}, expected 3`);
    assert.ok(Math.abs(clipped.max.y - 3) < CLOSE, `max.y ${clipped.max.y}, expected 3`);
    assert.ok(Math.abs(clipped.max.z - 10) < CLOSE);
  });

  it('honours a flipped cut, keeping the far half instead of the near one', () => {
    // The clipper expresses "keep the other side" by negating both the normal
    // and the offset, so this must trim min.x rather than max.x.
    const clipped = clipBoxToHalfSpace(UNIT, { x: -1, y: 0, z: 0 }, -7.5);
    assert.ok(clipped);
    assert.ok(Math.abs(clipped.min.x - 7.5) < CLOSE, `min.x ${clipped.min.x}`);
    assert.ok(Math.abs(clipped.max.x - 10) < CLOSE);
  });
});
