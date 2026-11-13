/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `readDimension` against hand-built annotation sources: what the reader
 * makes of the writer's item order and pset fields. The full write → export →
 * WASM parse → read path is `dimension-markup-roundtrip.test.ts`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DRAWING_MARKUP_OBJECTTYPE } from '@ifc-lite/create';
import type { DrawingLine2D } from '@ifc-lite/renderer';
import { readDrawingMarkupAnnotation, type DrawingMarkupAnnotationSource } from './drawing-markup-read.js';

const seg = (x1: number, y1: number, x2: number, y2: number): DrawingLine2D =>
  ({ line: { start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }, category: 'annotation', ownerId: 7 }) as DrawingLine2D;

const PLANE = { axis: 'front', position: 40, flipped: true };

function source(overrides: Partial<DrawingMarkupAnnotationSource> = {}, props: Record<string, string> = {}): DrawingMarkupAnnotationSource {
  return {
    expressId: 7,
    objectType: DRAWING_MARKUP_OBJECTTYPE.DIMENSION,
    // a→b, then the dimension line 0.5 m to the left of a→b (+y), then an extension line.
    lines: [seg(1, 2, 5, 2), seg(1, 2.5, 5, 2.5), seg(1, 2.1, 1, 2.7)],
    texts: [],
    fills: [],
    quantities: new Map([['Distance', 4]]),
    properties: new Map(Object.entries({
      Offset: '0.5',
      Orientation: 'aligned',
      Text: 'W <>',
      RefA: 'IfcWall:2O2Fr$t4X7Zf8NOew3FL9r',
      RefB: 'IfcColumn:0Mh5r$t4X7Zf8NOew3FL9r',
      Plane: JSON.stringify(PLANE),
      ...props,
    })),
    ...overrides,
  };
}

function read(src: DrawingMarkupAnnotationSource, anchor = {}) {
  const result = readDrawingMarkupAnnotation(src, anchor);
  if (!result) return null;
  assert.equal(result.kind, 'dimension');
  return result.kind === 'dimension' ? result.value : null;
}

describe('readDimension', () => {
  it('restores the points, offset, orientation, text, refs and plane', () => {
    assert.deepEqual(read(source()), {
      id: 'ifc-dimension-7',
      a: { x: 1, y: 2 },
      b: { x: 5, y: 2 },
      orientation: 'aligned',
      offset: 0.5,
      text: 'W <>',
      refs: {
        a: { ifcType: 'IfcWall', globalId: '2O2Fr$t4X7Zf8NOew3FL9r' },
        b: { ifcType: 'IfcColumn', globalId: '0Mh5r$t4X7Zf8NOew3FL9r' },
      },
      plane: PLANE,
    });
  });

  it('leaves absent optional fields absent', () => {
    const bare = read({ ...source(), properties: new Map([['Offset', '0.5'], ['Orientation', 'horizontal']]) });
    assert.ok(bare);
    assert.equal('text' in bare, false, 'no Text property, no override');
    assert.equal('refs' in bare, false, 'no RefA/RefB, no refs');
    assert.equal('plane' in bare, false, 'no Plane, no stamp');
  });

  it('takes the offset sign from the drawn line, so a mirrored frame keeps the line on its side', () => {
    // The same dimension seen through a y reflection: points and line mirrored, stored Offset unchanged.
    const mirrored = read(source({ lines: [seg(1, -2, 5, -2), seg(1, -2.5, 5, -2.5)] }));
    assert.ok(mirrored);
    assert.ok(Math.abs(mirrored.offset - -0.5) < 1e-12, `offset ${mirrored.offset} should follow the drawn line`);
  });

  it('falls back to the stored Offset, in the native unit, when there is no drawn line', () => {
    // Parsed geometry is already metres; only the stored scalars are native (mm here).
    const dim = read(source({ lines: [seg(1, 2, 5, 2)], quantities: new Map([['Distance', 4000]]) }, { Offset: '500' }),
      { lengthUnitScale: 0.001 });
    assert.ok(dim);
    assert.equal(dim.offset, 0.5);
  });

  it('skips a dimension whose required fields are missing or malformed', () => {
    const cases: Array<[string, DrawingMarkupAnnotationSource]> = [
      ['no geometry', source({ lines: [] })],
      ['no Orientation', { ...source(), properties: new Map([['Offset', '0.5']]) }],
      ['bad Orientation', source({}, { Orientation: 'diagonal' })],
      ['non-numeric Offset', source({}, { Offset: 'wide' })],
      ['bad RefA', source({}, { RefA: 'no-colon' })],
      ['Plane not JSON', source({}, { Plane: '{axis' })],
      ['Plane missing fields', source({}, { Plane: '{"axis":"down"}' })],
    ];
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      for (const [label, src] of cases) assert.equal(read(src), null, label);
    } finally {
      console.warn = originalWarn;
    }
  });
});
