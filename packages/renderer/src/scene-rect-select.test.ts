/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { selectBoundingBoxesInRect } from './scene-rect-select.js';
import type { BoundingBox } from './scene-raycaster.js';

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

/**
 * A real reverse-Z perspective view-projection: eye at the origin looking down
 * -z, 90 degree fov, aspect 1, near 0.1, infinite far — i.e.
 * `MathUtils.perspectiveReverseZ(PI/2, 1, 0.1, inf)` with an identity view.
 * Clip space works out to cx = x, cy = y, cz = 0.1, cw = -z, so ndc z = 0.1/-z
 * is 1 at z = -0.1 and tends to 0 far away, and the near plane is z = -0.1.
 */
const PERSPECTIVE_NEAR_0_1 = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 0, -1,
  0, 0, 0.1, 0,
]);

/**
 * A reverse-Z orthographic view-projection with a FINITE far plane, so the
 * far-side clip actually bites: `MathUtils.orthographicReverseZ(-1, 1, -1, 1,
 * 1, 10)` with an identity view. cw = 1 and ndc z = (z + 10) / 9, which is 1 at
 * z = -1 (near) and 0 at z = -10 (far).
 */
const ORTHO_NEAR_1_FAR_10 = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1 / 9, 0,
  0, 0, 10 / 9, 1,
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

  // A box crossing the near plane used to be added unconditionally, for any
  // rect anywhere on screen — the corners in front of the camera understate the
  // extent, and the code punted rather than clip. The population that reaches
  // this CPU path is large models, where the user is usually standing INSIDE
  // the building, so the floor, ceiling and surrounding walls all straddle and
  // a small drag over one object selected all of them. Clipping to the near
  // plane first gives the box its true visible extent. (#1904)
  describe('a box straddling the near plane', () => {
    // A floor slab underfoot: 20m x 20m, 100mm thick, 2m below the eye, running
    // from 10m in front to 10m BEHIND the camera. Clipped to z <= -0.1 it
    // projects to screen y 59.5..1050 — entirely below the horizon.
    const slab = new Map([[1, box(-10, -2, -10, 10, -1.9, 10)]]);

    it('is not selected by a rect over empty space above it', () => {
      const hits = selectBoundingBoxesInRect(
        slab, PERSPECTIVE_NEAR_0_1, { x0: 40, y0: 10, x1: 45, y1: 15 }, W, H,
      );
      assert.deepStrictEqual(
        hits, new Set(),
        'a 5px drag near the top of the screen must not select the floor under your feet',
      );
    });

    it('is still selected by a rect over the part of it that is visible', () => {
      const hits = selectBoundingBoxesInRect(
        slab, PERSPECTIVE_NEAR_0_1, { x0: 40, y0: 70, x1: 45, y1: 75 }, W, H,
      );
      assert.deepStrictEqual(
        hits, new Set([1]),
        'clipping must not cost the straddling box its real screen extent',
      );
    });
  });

  it('ignores a box nearer than the near plane', () => {
    // z = -0.05..-0.02 is in front of the eye (w > 0, so the old corner-only
    // test projected it into the middle of the screen) but inside the near
    // plane at z = -0.1, where the GPU clips it away.
    const boxes = new Map([[1, box(-0.001, -0.001, -0.05, 0.001, 0.001, -0.02)]]);
    const hits = selectBoundingBoxesInRect(
      boxes, PERSPECTIVE_NEAR_0_1, { x0: 0, y0: 0, x1: W, y1: H }, W, H,
    );
    assert.deepStrictEqual(hits, new Set(), 'near-clipped geometry is not on screen');
  });

  it('ignores a box beyond the far plane', () => {
    // z = -12..-11 is past the far plane at z = -10, so ndc z < 0 and the GPU
    // never rasterises it — but w = 1 > 0 and x/y project straight into the
    // middle of the rect.
    const boxes = new Map([[1, box(-0.2, -0.2, -12, 0.2, 0.2, -11)]]);
    const hits = selectBoundingBoxesInRect(
      boxes, ORTHO_NEAR_1_FAR_10, { x0: 0, y0: 0, x1: W, y1: H }, W, H,
    );
    assert.deepStrictEqual(hits, new Set(), 'far-clipped geometry is not on screen');
  });

  it('keeps a box straddling the far plane, clipped rather than dropped', () => {
    const boxes = new Map([[1, box(-0.2, -0.2, -12, 0.2, 0.2, -8)]]);
    const hits = selectBoundingBoxesInRect(
      boxes, ORTHO_NEAR_1_FAR_10, { x0: 0, y0: 0, x1: W, y1: H }, W, H,
    );
    assert.deepStrictEqual(hits, new Set([1]), 'the part in front of the far plane is visible');
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
