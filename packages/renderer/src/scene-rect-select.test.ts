/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { selectBoundingBoxesInRect } from './scene-rect-select.ts';
import type { BoundingBox } from './scene-raycaster.ts';

const W = 100;
const H = 100;

function box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): BoundingBox {
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

/**
 * Identity view-projection: clip == world, w == 1. NDC x/y map straight to the
 * canvas, so a box spanning [-1,1] covers the full 100x100 viewport and a box
 * at [0, 0.2] lands at screen x 50..60, y 40..50 (Y flips).
 */
const IDENTITY = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

/**
 * Column-major matrix whose w component is `-z`, i.e. the standard sign
 * convention where the camera looks down -z and anything at z > 0 is behind it.
 */
const W_IS_NEGATIVE_Z = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, -1,
  0, 0, 0, 0,
]);

describe('selectBoundingBoxesInRect (#1904)', () => {
  it('selects a box whose projection lands inside the rect', () => {
    const boxes = new Map([[1, box(0, 0, 0, 0.2, 0.2, 0)]]);
    // Screen AABB is x 50..60, y 40..50.
    const hits = selectBoundingBoxesInRect(boxes, IDENTITY, { x0: 45, y0: 35, x1: 65, y1: 55 }, W, H);
    assert.deepStrictEqual(hits, new Set([1]));
  });

  it('rejects a box whose projection is outside the rect', () => {
    const boxes = new Map([[1, box(0, 0, 0, 0.2, 0.2, 0)]]);
    // Rect sits in the top-left corner; the box projects to the middle.
    const hits = selectBoundingBoxesInRect(boxes, IDENTITY, { x0: 0, y0: 0, x1: 10, y1: 10 }, W, H);
    assert.deepStrictEqual(hits, new Set());
  });

  it('selects on partial overlap — the rect need not contain the whole box', () => {
    const boxes = new Map([[1, box(-1, -1, 0, 1, 1, 0)]]); // fills the viewport
    const hits = selectBoundingBoxesInRect(boxes, IDENTITY, { x0: 0, y0: 0, x1: 5, y1: 5 }, W, H);
    assert.deepStrictEqual(hits, new Set([1]));
  });

  it('normalises a rect dragged right-to-left / bottom-to-top', () => {
    const boxes = new Map([[1, box(0, 0, 0, 0.2, 0.2, 0)]]);
    const dragged = selectBoundingBoxesInRect(boxes, IDENTITY, { x0: 65, y0: 55, x1: 45, y1: 35 }, W, H);
    assert.deepStrictEqual(dragged, new Set([1]), 'drag direction must not change the result');
  });

  it('skips hidden entities', () => {
    const boxes = new Map([
      [1, box(0, 0, 0, 0.2, 0.2, 0)],
      [2, box(0, 0, 0, 0.2, 0.2, 0)],
    ]);
    const hits = selectBoundingBoxesInRect(
      boxes, IDENTITY, { x0: 0, y0: 0, x1: W, y1: H }, W, H, new Set([1]),
    );
    assert.deepStrictEqual(hits, new Set([2]));
  });

  it('restricts to the isolated set when one is active', () => {
    const boxes = new Map([
      [1, box(0, 0, 0, 0.2, 0.2, 0)],
      [2, box(0, 0, 0, 0.2, 0.2, 0)],
    ]);
    const hits = selectBoundingBoxesInRect(
      boxes, IDENTITY, { x0: 0, y0: 0, x1: W, y1: H }, W, H, undefined, new Set([2]),
    );
    assert.deepStrictEqual(hits, new Set([2]));
  });

  it('treats an empty isolated set as "nothing selectable", not "no isolation"', () => {
    const boxes = new Map([[1, box(0, 0, 0, 0.2, 0.2, 0)]]);
    const hits = selectBoundingBoxesInRect(
      boxes, IDENTITY, { x0: 0, y0: 0, x1: W, y1: H }, W, H, undefined, new Set(),
    );
    assert.deepStrictEqual(hits, new Set());
  });

  it('ignores geometry entirely behind the camera', () => {
    // z = 1..2 with w = -z gives w = -1..-2: every corner is behind.
    const boxes = new Map([[1, box(-0.1, -0.1, 1, 0.1, 0.1, 2)]]);
    const hits = selectBoundingBoxesInRect(
      boxes, W_IS_NEGATIVE_Z, { x0: 0, y0: 0, x1: W, y1: H }, W, H,
    );
    assert.deepStrictEqual(hits, new Set(), 'a box behind the camera must not be selectable');
  });

  it('selects a box straddling the camera plane', () => {
    // z = -1..1 crosses w = 0. The projected corners understate the true
    // extent, so the screen-AABB test alone would wrongly reject it.
    const boxes = new Map([[1, box(-0.1, -0.1, -1, 0.1, 0.1, 1)]]);
    const hits = selectBoundingBoxesInRect(
      boxes, W_IS_NEGATIVE_Z, { x0: 0, y0: 0, x1: 1, y1: 1 }, W, H,
    );
    assert.deepStrictEqual(hits, new Set([1]));
  });

  it('returns empty for a degenerate viewport instead of selecting everything', () => {
    const boxes = new Map([[1, box(0, 0, 0, 0.2, 0.2, 0)]]);
    const hits = selectBoundingBoxesInRect(boxes, IDENTITY, { x0: 0, y0: 0, x1: 10, y1: 10 }, 0, 0);
    assert.deepStrictEqual(hits, new Set());
  });

  it('excludes an entity the crop box removes, matching what is visible', () => {
    const boxes = new Map([[1, box(0, 0, 0, 0.2, 0.2, 0)]]);
    const clip = { clipBox: { min: [10, 10, 10] as [number, number, number], max: [20, 20, 20] as [number, number, number], enabled: true } };
    const hits = selectBoundingBoxesInRect(
      boxes, IDENTITY, { x0: 0, y0: 0, x1: W, y1: H }, W, H, undefined, undefined, clip,
    );
    assert.deepStrictEqual(hits, new Set(), 'clipped-away geometry must be unselectable');
  });
});
