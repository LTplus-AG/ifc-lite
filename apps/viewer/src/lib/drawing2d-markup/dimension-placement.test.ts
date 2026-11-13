/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dimensionGraphics } from './dimension-graphics';
import { placementOffset, placementOrientation, previewDimension } from './dimension-placement';
import { drawingViewMapping } from './drawing-view-mapping';

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('dimension placement', () => {
  it('is aligned without Shift, whatever the cursor', () => {
    assert.equal(placementOrientation({ x: 0, y: 0 }, { x: 3, y: 1 }, { x: 9, y: 9 }, false), 'aligned');
  });

  it('with Shift locks horizontal when pulled above or below, vertical when pulled beside', () => {
    const a = { x: 0, y: 0 }, b = { x: 4, y: 2 };
    assert.equal(placementOrientation(a, b, { x: 2, y: 5 }, true), 'horizontal');
    assert.equal(placementOrientation(a, b, { x: 2, y: -3 }, true), 'horizontal');
    assert.equal(placementOrientation(a, b, { x: 7, y: 1 }, true), 'vertical');
    assert.equal(placementOrientation(a, b, { x: -2, y: 1 }, true), 'vertical');
  });

  it('falls back to the other axis when the locked one would measure nothing', () => {
    // a and b on one vertical: a horizontal dimension would read 0.
    assert.equal(placementOrientation({ x: 1, y: 0 }, { x: 1, y: 3 }, { x: 1, y: 8 }, true), 'vertical');
    assert.equal(placementOrientation({ x: 0, y: 2 }, { x: 5, y: 2 }, { x: 9, y: 2 }, true), 'horizontal');
  });

  it('puts the dimension line through the cursor (offset sign matches dimensionGraphics)', () => {
    const a = { x: 0, y: 0 }, b = { x: 4, y: 0 };
    for (const cursor of [{ x: 2, y: 1.5 }, { x: 2, y: -0.75 }, { x: -3, y: 2 }]) {
      for (const orientation of ['aligned', 'horizontal', 'vertical'] as const) {
        const bb = orientation === 'vertical' ? { x: 0, y: 4 } : b;
        const offset = placementOffset(a, bb, orientation, cursor);
        const g = dimensionGraphics({ id: 'd', a, b: bb, offset, orientation }, { paperScale: 100, format: String });
        const [p, q] = g.lines[0];
        // The cursor lies on the infinite dimension line: cross product ~ 0.
        const cross = (q.x - p.x) * (cursor.y - p.y) - (q.y - p.y) * (cursor.x - p.x);
        assert.ok(near(cross, 0, 1e-9), `${orientation} line misses the cursor ${JSON.stringify(cursor)}: ${cross}`);
      }
    }
  });

  it('previews nothing before the first click, a rubber band after it, and follows the cursor after the second', () => {
    assert.equal(previewDimension([], { x: 1, y: 1 }, false), null);
    assert.equal(previewDimension([{ x: 0, y: 0 }], null, false), null);
    const band = previewDimension([{ x: 0, y: 0 }], { x: 2, y: 0 }, false);
    assert.deepEqual([band?.b, band?.offset, band?.orientation], [{ x: 2, y: 0 }, 0, 'aligned']);
    const placed = previewDimension([{ x: 0, y: 0 }, { x: 4, y: 0 }], { x: 2, y: 1 }, false);
    assert.ok(placed && near(placed.offset, 1), `offset ${placed?.offset}`);
    assert.equal(previewDimension([{ x: 0, y: 0 }, { x: 4, y: 2 }], { x: 2, y: 6 }, true)?.orientation, 'horizontal');
  });
});

describe('drawing view mapping', () => {
  const transform = { x: 40, y: -15, scale: 120 };
  for (const axis of ['down', 'front', 'side'] as const) {
    it(`${axis}: matches the canvas' direct-mode scale and round-trips`, () => {
      const m = drawingViewMapping(transform, axis);
      const p = { x: 1.25, y: -3.5 };
      const sx = axis === 'side' ? -transform.scale : transform.scale;
      const sy = axis === 'down' ? transform.scale : -transform.scale;
      const s = m.toScreen(p);
      assert.ok(near(s.x, p.x * sx + transform.x) && near(s.y, p.y * sy + transform.y), JSON.stringify(s));
      const back = m.toDrawing(s);
      assert.ok(near(back.x, p.x) && near(back.y, p.y), JSON.stringify(back));
      assert.equal(m.pxPerMetre, transform.scale);
    });

    it(`${axis}: in sheet mode flips, places on paper, then scales millimetres`, () => {
      const sheet = { translateX: 30, translateY: 50, scaleFactor: 10 };
      const m = drawingViewMapping({ x: 5, y: 7, scale: 2 }, axis, sheet);
      const p = { x: 2, y: 3 };
      const fx = axis === 'side' ? -1 : 1, fy = axis === 'down' ? 1 : -1;
      const s = m.toScreen(p);
      assert.ok(near(s.x, (fx * 2 * 10 + 30) * 2 + 5) && near(s.y, (fy * 3 * 10 + 50) * 2 + 7), JSON.stringify(s));
      const back = m.toDrawing(s);
      assert.ok(near(back.x, 2) && near(back.y, 3), JSON.stringify(back));
      assert.equal(m.pxPerMetre, 20);
    });
  }
});
