/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { wX, wY, type Fit } from '@/lib/rooms/plate-geometry.js';
import { clampToCanvas, zoomByScale, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE } from './plan-zoom.js';

const CANVAS_W = 420;
const CANVAS_H = 340;
const FIT: Fit = { scale: 20, offX: 36, offY: 304 };

describe('clampToCanvas', () => {
  it('leaves a position inside the canvas alone', () => {
    assert.deepEqual(clampToCanvas(120, 80, CANVAS_W, CANVAS_H), [120, 80]);
  });

  it('clamps to the edges rather than reporting an off-canvas position', () => {
    assert.deepEqual(clampToCanvas(-40, -12, CANVAS_W, CANVAS_H), [0, 0]);
    assert.deepEqual(clampToCanvas(9999, 9999, CANVAS_W, CANVAS_H), [CANVAS_W, CANVAS_H]);
  });

  it('keeps a captured drag off the canvas from producing an extreme world point', () => {
    // The failure this exists for: during a vertex drag the pointer is
    // captured, so dragging past the panel reported coordinates far outside the
    // SVG. Unclamped, that becomes a world position hundreds of metres away —
    // the room "disappeared" and the SVG rasterised a polygon spanning to
    // extreme coordinates, freezing the browser.
    const runaway = 40_000;
    const [cx, cy] = clampToCanvas(runaway, runaway, CANVAS_W, CANVAS_H);
    const world = [wX(FIT, cx), wY(FIT, cy)];
    assert.ok(Math.abs(world[0]) < 100 && Math.abs(world[1]) < 100,
      `a clamped pointer must stay near the plan, got ${world.join(',')}`);
    // Same input unclamped, for contrast: this is the value that froze it.
    assert.ok(Math.abs(wX(FIT, runaway)) > 1000, 'the unclamped value really is extreme');
  });

  it('clamps each axis independently', () => {
    assert.deepEqual(clampToCanvas(-5, 100, CANVAS_W, CANVAS_H), [0, 100]);
    assert.deepEqual(clampToCanvas(100, 9999, CANVAS_W, CANVAS_H), [100, CANVAS_H]);
  });
});

describe('zoomByScale (one eased wheel step, #9507)', () => {
  it('zooms in for a scale above 1 and out below it', () => {
    assert.ok(zoomByScale(FIT, 1.1, 200, 170)!.scale > FIT.scale);
    assert.ok(zoomByScale(FIT, 1 / 1.1, 200, 170)!.scale < FIT.scale);
  });

  it('keeps the point under the cursor fixed', () => {
    const ax = 200, ay = 170;
    const before = [wX(FIT, ax), wY(FIT, ay)];
    const next = zoomByScale(FIT, 1.25, ax, ay)!;
    const after = [wX(next, ax), wY(next, ay)];
    assert.ok(Math.abs(before[0] - after[0]) < 1e-9, 'x under the cursor is unchanged');
    assert.ok(Math.abs(before[1] - after[1]) < 1e-9, 'y under the cursor is unchanged');
  });

  it('refuses a step that would leave the usable range, moving NOTHING', () => {
    // Returning null rather than a scale-clamped fit is the point: clamping the
    // scale while still applying the offset shift would drift the plan sideways
    // under a wheel that no longer zooms.
    const tooFarIn: Fit = { scale: MAX_ZOOM_SCALE, offX: 10, offY: 20 };
    assert.equal(zoomByScale(tooFarIn, 1.5, 100, 100), null);
    const tooFarOut: Fit = { scale: MIN_ZOOM_SCALE, offX: 10, offY: 20 };
    assert.equal(zoomByScale(tooFarOut, 1 / 1.5, 100, 100), null);
  });

  it('accepts a step that lands exactly ON a bound', () => {
    // A scale of exactly 1 leaves the scale bit-identical; sitting on the limit
    // must not blank the transform.
    for (const scale of [MIN_ZOOM_SCALE, MAX_ZOOM_SCALE]) {
      const next = zoomByScale({ scale, offX: 7, offY: 11 }, 1, 100, 100);
      assert.ok(next, `a no-op step at scale ${scale} must not be refused`);
      assert.equal(next.scale, scale);
    }
  });

  it('refuses at the bounds themselves, not at some other scale', () => {
    // Bisect for the step where accept flips to refuse, so the test pins WHERE
    // the limit is. A wrong bound constant, or a comparison against the wrong
    // field, moves this threshold.
    const from: Fit = { scale: 10, offX: 3, offY: 4 };
    const flipScale = (accepted: number, refused: number): number => {
      for (let i = 0; i < 200; i++) {
        const mid = Math.sqrt(accepted * refused);
        if (zoomByScale(from, mid, 100, 100)) accepted = mid; else refused = mid;
      }
      return zoomByScale(from, accepted, 100, 100)!.scale;
    };
    const outLimit = flipScale(1, 1e-6);
    assert.ok(Math.abs(outLimit - MIN_ZOOM_SCALE) / MIN_ZOOM_SCALE < 1e-9,
      `zoom-out stops at ${outLimit}, expected ${MIN_ZOOM_SCALE}`);
    const inLimit = flipScale(1, 1e6);
    assert.ok(Math.abs(inLimit - MAX_ZOOM_SCALE) / MAX_ZOOM_SCALE < 1e-9,
      `zoom-in stops at ${inLimit}, expected ${MAX_ZOOM_SCALE}`);
  });
});
