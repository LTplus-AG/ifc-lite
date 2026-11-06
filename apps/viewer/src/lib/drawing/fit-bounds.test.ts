/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `drawingFitBounds` (#8802): Fit starts from the cut and grows through
 * nearby content; far-off small objects stay drawn but outside the frame.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import { drawingFitBounds } from './fit-bounds';

const rect = (x0: number, y0: number, x1: number, y1: number) =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const cut = (entityId: number, x0: number, y0: number, x1: number, y1: number) =>
  ({ polygon: { outer: rect(x0, y0, x1, y1), holes: [] }, entityId, ifcType: 'IfcWall', modelIndex: 0, isCut: true });
const line = (entityId: number, x0: number, y0: number, x1: number, y1: number) =>
  ({ line: { start: { x: x0, y: y0 }, end: { x: x1, y: y1 } }, category: 'projection', visibility: 'visible', entityId, ifcType: 'IfcElement', modelIndex: 0 });

function drawingOf(parts: Partial<Drawing2D>, bounds: Drawing2D['bounds']): Drawing2D {
  return { cutPolygons: [], lines: [], projectionPolygons: [], ...parts, bounds } as unknown as Drawing2D;
}
const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ min: { x: minX, y: minY }, max: { x: maxX, y: maxY } });

describe('drawingFitBounds', () => {
  it('frames all content when nothing is cut (a projection-only plan above the model top)', () => {
    const d = drawingOf({ lines: [line(1, 0, 0, 10, 0), line(2, 500, 500, 501, 501)] as Drawing2D['lines'] }, box(0, 0, 501, 501));
    assert.deepEqual(drawingFitBounds(d), d.bounds);
  });

  it('grows through touching content in several steps, and stops at a detached object', () => {
    const d = drawingOf({
      cutPolygons: [cut(1, 0, 0, 0.4, 0.4)] as Drawing2D['cutPolygons'], // a cut column
      lines: [
        line(2, -20, -20, 20, 20),   // a slab under the column: overlaps it
        line(3, 20, 0, 28, 0),       // a terrace touching the slab's edge
        line(4, 60, 60, 61, 61),     // a marker ~51 m off a 48 m frame: beyond a quarter of it
      ] as Drawing2D['lines'],
    }, box(-20, -20, 61, 61));
    assert.deepEqual(drawingFitBounds(d), box(-20, -20, 28, 20));
  });

  it('judges an entity by all of its lines: one near the cut brings the whole element in', () => {
    const d = drawingOf({
      cutPolygons: [cut(1, 0, 0, 10, 10)] as Drawing2D['cutPolygons'],
      lines: [line(2, 11, 0, 11, 1), line(2, 100, 0, 100, 1)] as Drawing2D['lines'],
    }, box(0, 0, 100, 10));
    assert.deepEqual(drawingFitBounds(d), box(0, 0, 100, 10));
  });

  it('always frames the visible references, as Fit documents', () => {
    const d = drawingOf({ cutPolygons: [cut(1, 0, 0, 6, 6)] as Drawing2D['cutPolygons'] }, box(-100, -100, 6, 6));
    assert.deepEqual(drawingFitBounds(d, box(-100, -100, -90, -90)), box(-100, -100, 6, 6));
  });
});
