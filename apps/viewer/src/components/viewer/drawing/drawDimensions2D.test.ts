/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SnapMode } from '@/lib/drafting-core/types';
import { drawingViewMapping } from '@/lib/drawing2d-markup/drawing-view-mapping';
import type { Dimension2D } from '@/store/slices/drawing2DDimensions';
import type { DrawnSectionPlane } from '@/store/slices/drawing2DSlice';
import {
  DIMENSION_TEXT_MIN_PX, dimensionScreenLayout, drawDimensions2D, drawSnapGlyph, hitTestDimensions, type DimensionLayoutContext,
} from './drawDimensions2D';

interface Call { op: string; args: unknown[]; state: { font: string; alpha: number; dash: number[] } }

/** A 2D context that records every call with the state it was made in. */
function recordingContext() {
  const calls: Call[] = [];
  const state = { font: '', globalAlpha: 1, dash: [] as number[], strokeStyle: '', fillStyle: '', lineWidth: 1 };
  const stack: typeof state[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, key: string) {
      if (key in state && key !== 'dash') return (state as Record<string, unknown>)[key];
      return (...args: unknown[]) => {
        if (key === 'save') stack.push({ ...state, dash: [...state.dash] });
        if (key === 'restore') Object.assign(state, stack.pop());
        if (key === 'setLineDash') state.dash = [...(args[0] as number[])];
        calls.push({ op: key, args, state: { font: state.font, alpha: state.globalAlpha, dash: [...state.dash] } });
      };
    },
    set(_t, key: string, value) {
      (state as Record<string, unknown>)[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const plane = (position: number): DrawnSectionPlane => ({ axis: 'down', position, flipped: false });
const dim = (id: string, extra: Partial<Dimension2D> = {}): Dimension2D =>
  ({ id, a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: -1, orientation: 'aligned', ...extra });
const layout = (scale: number): DimensionLayoutContext => ({
  mapping: drawingViewMapping({ x: 0, y: 0, scale }, 'down'), paperScale: 100, format: (m) => String(Math.round(m * 1000)),
});

describe('drawDimensions2D', () => {
  it('draws text at its true paper size when that is legible, and at 11 px when it is not', () => {
    // 2.5 mm at 1:100 is 0.25 m; at 200 px/m that is 50 px.
    assert.equal(dimensionScreenLayout(dim('d'), layout(200)).text.fontPx, 50);
    const tiny = dimensionScreenLayout(dim('d'), layout(10));
    assert.equal(tiny.text.fontPx, DIMENSION_TEXT_MIN_PX);
    // The enlarged text clears the dimension line by more than half its height.
    const [p, q] = tiny.lines[0];
    const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    assert.ok(Math.hypot(tiny.text.at.x - mid.x, tiny.text.at.y - mid.y) > DIMENSION_TEXT_MIN_PX / 2,
      `text centre ${JSON.stringify(tiny.text.at)} sits on the line at ${JSON.stringify(mid)}`);
    assert.equal(tiny.text.value, '4000');
  });

  it('draws a dimension from another cut dimmed and dashed, and one from this cut solid', () => {
    const { ctx, calls } = recordingContext();
    drawDimensions2D(ctx, {
      dimensions: [dim('here', { plane: plane(1) }), dim('there', { plane: plane(4), a: { x: 0, y: 5 }, b: { x: 6, y: 5 } })],
      currentPlane: plane(1), selectedId: null, layout: layout(100),
    });
    const strokes = calls.filter((c) => c.op === 'stroke');
    assert.ok(strokes.length >= 4, `expected line and tick strokes for both, got ${strokes.length}`);
    const solid = strokes.filter((c) => c.state.alpha === 1 && c.state.dash.length === 0);
    const dimmed = strokes.filter((c) => c.state.alpha < 1 && c.state.dash.length > 0);
    assert.ok(solid.length > 0, 'the on-plane dimension is solid');
    assert.ok(dimmed.length > 0, 'the other-cut dimension is dimmed and dashed');
    const texts = calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]);
    // #10076 review: distinct lengths, so a label taken from the wrong dimension fails.
    assert.deepEqual(texts, ['4000', '6000']);
  });

  it('draws one distinct glyph per snap mode', () => {
    const signatures = new Set<string>();
    for (const mode of ['endpoint', 'midpoint', 'intersection', 'perpendicular', 'nearest'] as SnapMode[]) {
      const { ctx, calls } = recordingContext();
      drawSnapGlyph(ctx, { x: 10, y: 10 }, mode);
      signatures.add(calls.filter((c) => !['save', 'restore', 'setLineDash'].includes(c.op)).map((c) => `${c.op}(${c.args.join(' ')})`).join(','));
    }
    assert.equal(signatures.size, 5, [...signatures].join(' | '));
  });

  it('draws the preview, placed points, markers and snap glyph only when given', () => {
    const { ctx, calls } = recordingContext();
    drawDimensions2D(ctx, { dimensions: [], currentPlane: null, selectedId: null, layout: layout(100) });
    assert.equal(calls.length, 0);
    const busy = recordingContext();
    drawDimensions2D(busy.ctx, {
      dimensions: [], currentPlane: null, selectedId: null, layout: layout(100),
      preview: dim('preview'), placedPoints: [{ x: 0, y: 0 }], markers: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
      snap: { point: { x: 4, y: 0 }, mode: 'endpoint' },
    });
    const ops = busy.calls.map((c) => c.op);
    assert.equal(ops.filter((op) => op === 'fillRect').length, 2, 'one faint marker per key point');
    assert.ok(ops.includes('arc'), 'placed point');
    assert.ok(ops.includes('rect'), 'endpoint glyph');
    assert.ok(ops.includes('fillText'), 'preview value');
  });
});

describe('hitTestDimensions', () => {
  const c = layout(100);
  const dims = [dim('low'), dim('top', { a: { x: 0, y: 3 }, b: { x: 4, y: 3 } })];
  it('hits a stroke within the threshold, the text, and nothing elsewhere', () => {
    const g = dimensionScreenLayout(dims[0], c);
    const [p, q] = g.lines[0];
    assert.equal(hitTestDimensions(dims, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 + 4 }, c)?.id, 'low');
    assert.equal(hitTestDimensions(dims, g.text.at, c)?.id, 'low');
    assert.equal(hitTestDimensions(dims, { x: -500, y: -500 }, c), null);
    const top = dimensionScreenLayout(dims[1], c).lines[0][0];
    assert.equal(hitTestDimensions(dims, top, c)?.id, 'top');
  });
});
