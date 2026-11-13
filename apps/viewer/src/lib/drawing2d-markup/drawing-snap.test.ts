/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The drawing snap adapter over the vendored drafting core. Fixtures are
 * small hand-built `Drawing2D`s in drawing metres; the split-face case is
 * modelled on a 6.00 m wall face the generator delivered as 4.2624 m +
 * 1.74 m collinear pieces.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Drawing2D, DrawingLine, DrawingPolygon, Point2D } from '@ifc-lite/drawing-2d';
import { buildDrawingSnapShapes, findDrawingSnap, getDrawingSnapIndex, snapHitFit } from './drawing-snap';

const SPLIT = 4.2624;
const TOL = 0.05;

const P = (x: number, y: number): Point2D => ({ x, y });

function polygon(entityId: number, outer: Point2D[], holes: Point2D[][] = [], modelIndex = 0): DrawingPolygon {
  return { polygon: { outer, holes }, entityId, ifcType: 'IfcWall', modelIndex, isCut: true };
}

function line(entityId: number, a: Point2D, b: Point2D, extra: Partial<DrawingLine> = {}): DrawingLine {
  return {
    line: { start: a, end: b },
    category: 'projection',
    visibility: 'visible',
    entityId,
    ifcType: 'IfcWall',
    modelIndex: 0,
    depth: 0,
    ...extra,
  };
}

function drawing(cutPolygons: DrawingPolygon[], lines: DrawingLine[] = []): Drawing2D {
  return {
    config: {
      plane: { axis: 'y', position: 1, flipped: false },
      projectionDepth: 10,
      includeHiddenLines: true,
      creaseAngle: 30,
      scale: 100,
    },
    lines,
    cutPolygons,
    projectionPolygons: [],
    bounds: { min: P(-10, -10), max: P(20, 20) },
    stats: {
      cutLineCount: 0,
      projectionLineCount: 0,
      hiddenLineCount: 0,
      silhouetteLineCount: 0,
      polygonCount: cutPolygons.length,
      totalTriangles: 0,
      processingTimeMs: 0,
    },
  };
}

/** Wall 10: 6.00 m x 0.20 m, its bottom face split at x = 4.2624. */
const splitWall = (): DrawingPolygon => polygon(10, [P(0, 0), P(SPLIT, 0), P(6, 0), P(6, 0.2), P(0, 0.2)]);

function near(actual: number, expected: number, what: string): void {
  assert.equal(Math.abs(actual - expected) < 1e-9, true, `${what}: ${actual} is not ${expected}`);
}

describe('drawing snap: collinear split vertices', () => {
  it('does not offer a polygon face split vertex as an endpoint', () => {
    const d = drawing([splitWall()]);
    const ring = buildDrawingSnapShapes(d).shapes[0];
    assert.equal(ring.type === 'polyline' && ring.pts.length === 4, true, 'split ring reduced to its 4 corners');
    const hit = findDrawingSnap(d, P(SPLIT, 0.001), { tolerance: TOL });
    assert.equal(hit !== null && hit.mode !== 'endpoint', true, `no endpoint at the split, got ${hit?.mode}`);
  });

  it('offers the true midpoint of the whole 6.00 m face', () => {
    const hit = findDrawingSnap(drawing([splitWall()]), P(3.01, 0.001), { tolerance: TOL });
    assert.equal(hit?.mode, 'midpoint', 'mode');
    near(hit?.point.x ?? NaN, 3, 'midpoint x');
    near(hit?.point.y ?? NaN, 0, 'midpoint y');
  });

  it('keeps a real corner', () => {
    const hit = findDrawingSnap(drawing([splitWall()]), P(5.99, 0.01), { tolerance: TOL });
    assert.equal(hit?.mode, 'endpoint', 'mode');
    near(hit?.point.x ?? NaN, 6, 'corner x');
    near(hit?.point.y ?? NaN, 0, 'corner y');
  });

  it('keeps the vertex where a different entity meets the face', () => {
    const crossWall = polygon(11, [P(SPLIT, -3), P(SPLIT + 0.2, -3), P(SPLIT + 0.2, 0), P(SPLIT, 0)]);
    const d = drawing([splitWall(), crossWall]);
    const ring = buildDrawingSnapShapes(d).shapes[0];
    assert.equal(ring.type === 'polyline' && ring.pts.length === 5, true, 'shared vertex kept in wall 10');
    const hit = findDrawingSnap(d, P(SPLIT - 0.01, 0.01), { tolerance: TOL });
    assert.equal(hit?.mode, 'endpoint', 'mode');
    near(hit?.point.x ?? NaN, SPLIT, 'shared vertex x');
  });

  it('joins collinear line pieces of one entity and keeps the joint another entity ends on', () => {
    const pieces = [line(20, P(0, 5), P(SPLIT, 5)), line(20, P(SPLIT, 5), P(6, 5))];
    const merged = buildDrawingSnapShapes(drawing([], pieces)).shapes;
    assert.equal(merged.length, 1, 'two pieces become one line');
    const mid = findDrawingSnap(drawing([], pieces), P(3.01, 5.001), { tolerance: TOL });
    assert.equal(mid?.mode, 'midpoint', 'mode');
    near(mid?.point.x ?? NaN, 3, 'merged midpoint x');

    const withStub = [...pieces, line(21, P(SPLIT, 5), P(SPLIT, 8))];
    const kept = buildDrawingSnapShapes(drawing([], withStub)).shapes;
    assert.equal(kept.length, 3, 'joint kept where entity 21 ends on it');
  });

  it('drops a split 5e-8 m off the chord near a corner, but keeps a 0.1 mm kink (#9927 deviation)', () => {
    // The 0.2 m end face of the sample wall "house left", split 0.0613 m from
    // its corner, with the split point as far off the chord as #9927 measured
    // on the real model. A 1e-6 rad angle test kept this vertex.
    const endFace = (dev: number): DrawingPolygon =>
      polygon(12, [P(3, -9), P(3.1387, -9 + dev), P(3.2, -9), P(3.2, -3), P(3, -3)]);
    const ring = (dev: number) => buildDrawingSnapShapes(drawing([endFace(dev)])).shapes[0];
    const split = ring(5e-8);
    assert.equal(split.type === 'polyline' && split.pts.length === 4, true, 'near-corner split dropped');
    const kink = ring(1e-4);
    assert.equal(kink.type === 'polyline' && kink.pts.length === 5, true, 'real 0.1 mm kink kept');
  });

  it('joins pieces whose shared end straddles a vertex-key cell edge (#10076 review)', () => {
    // 2e-8 m apart, on either side of the 1.2000005 cell edge of a 1e-6 grid.
    const pieces = [line(23, P(0, 12), P(1.20000049, 12)), line(23, P(1.20000051, 12), P(2, 12))];
    const merged = buildDrawingSnapShapes(drawing([], pieces)).shapes;
    assert.equal(merged.length, 1, 'two pieces become one line');
    const mid = findDrawingSnap(drawing([], pieces), P(1.01, 12.001), { tolerance: TOL });
    assert.equal(mid?.mode, 'midpoint', 'mode');
    near(mid?.point.x ?? NaN, 1, 'merged midpoint x');
    // The same straddle on a face shared with another entity still counts as shared.
    const stub = line(24, P(1.20000051, 12), P(1.20000051, 14));
    assert.equal(buildDrawingSnapShapes(drawing([], [...pieces, stub])).shapes.length, 3, 'joint kept where entity 24 ends on it');
  });

  it('keeps a corner between two pieces of the same entity', () => {
    const corner = [line(22, P(0, 8), P(2, 8)), line(22, P(2, 8), P(2, 10))];
    assert.equal(buildDrawingSnapShapes(drawing([], corner)).shapes.length, 2, 'L stays two lines');
  });
});

describe('drawing snap: mode priority and nearest hit', () => {
  it('prefers an endpoint over a nearer midpoint', () => {
    const hit = findDrawingSnap(drawing([], [line(30, P(0, 0), P(0.08, 0))]), P(0.04, 0), { tolerance: TOL });
    assert.equal(hit?.mode, 'endpoint', 'mode');
  });

  it('prefers an intersection over a nearer midpoint', () => {
    const lines = [line(31, P(0, 1), P(2, 1)), line(32, P(1.02, 0), P(1.02, 2))];
    const hit = findDrawingSnap(drawing([], lines), P(1, 1), { tolerance: TOL });
    assert.equal(hit?.mode, 'intersection', 'mode');
    near(hit?.point.x ?? NaN, 1.02, 'intersection x');
    assert.equal(hit?.source.entityId, 31, 'intersection names the element nearest the cursor');
  });

  it('prefers a midpoint over nearest, and offers nearest otherwise', () => {
    const d = drawing([], [line(33, P(0, 3), P(4, 3))]);
    assert.equal(findDrawingSnap(d, P(2.03, 3.01), { tolerance: TOL })?.mode, 'midpoint', 'midpoint in reach');
    const free = findDrawingSnap(d, P(1, 3.01), { tolerance: TOL });
    assert.equal(free?.mode, 'nearest', 'nothing but the curve in reach');
    near(free?.point.y ?? NaN, 3, 'nearest lies on the line');
  });

  it('offers the perpendicular foot from the reference point', () => {
    const d = drawing([], [line(34, P(0, 3), P(4, 3))]);
    const hit = findDrawingSnap(d, P(1.02, 3.01), { tolerance: TOL, from: P(1, 6) });
    assert.equal(hit?.mode, 'perpendicular', 'mode');
    near(hit?.point.x ?? NaN, 1, 'foot x');
    assert.equal(findDrawingSnap(d, P(1.02, 3.01), { tolerance: TOL })?.mode, 'nearest', 'no foot without `from`');
  });

  it('picks the nearest endpoint and names its element', () => {
    const lines = [line(40, P(9, 0), P(10, 0)), line(41, P(10.04, 0), P(11, 0))];
    const d = drawing([], lines);
    const right = findDrawingSnap(d, P(10.03, 0), { tolerance: TOL });
    near(right?.point.x ?? NaN, 10.04, 'nearer endpoint');
    assert.equal(right?.source.entityId, 41, 'source of the right endpoint');
    const left = findDrawingSnap(d, P(10.01, 0), { tolerance: TOL });
    near(left?.point.x ?? NaN, 10, 'nearer endpoint');
    assert.equal(left?.source.entityId, 40, 'source of the left endpoint');
  });

  it('returns null out of reach', () => {
    assert.equal(findDrawingSnap(drawing([splitWall()]), P(3, 1), { tolerance: TOL }), null, 'nothing within 5 cm');
  });
});

describe('drawing snap: sources, holes and input filtering', () => {
  it('maps a polygon snap to its entity and model', () => {
    const d = drawing([polygon(77, [P(0, 0), P(1, 0), P(1, 1), P(0, 1)], [], 2)]);
    const hit = findDrawingSnap(d, P(1.01, 1.01), { tolerance: TOL });
    assert.equal(hit?.source.entityId === 77 && hit.source.modelIndex === 2, true, `source ${JSON.stringify(hit?.source)}`);
  });

  it('indexes holes', () => {
    const hole = [P(2, 2), P(2, 3), P(3, 3), P(3, 2)];
    const d = drawing([polygon(78, [P(0, 0), P(5, 0), P(5, 5), P(0, 5)], [hole])]);
    assert.equal(buildDrawingSnapShapes(d).shapes.length, 2, 'outer and hole');
    const hit = findDrawingSnap(d, P(2.01, 2.99), { tolerance: TOL });
    assert.equal(hit?.mode, 'endpoint', 'hole corner mode');
    near(hit?.point.x ?? NaN, 2, 'hole corner x');
    near(hit?.point.y ?? NaN, 3, 'hole corner y');
    assert.equal(hit?.source.entityId, 78, 'hole source');
  });

  it('skips polygon triangulation cut lines and, by default, hidden lines', () => {
    const d = drawing(
      [polygon(79, [P(0, 0), P(4, 0), P(4, 4), P(0, 4)])],
      [line(79, P(0, 0), P(4, 4), { category: 'cut' }), line(80, P(10, 0), P(10, 4), { visibility: 'hidden' })],
    );
    assert.equal(findDrawingSnap(d, P(2.01, 2), { tolerance: TOL }), null, 'no snap on a triangulation edge');
    assert.equal(findDrawingSnap(d, P(10.01, 2), { tolerance: TOL }), null, 'hidden line skipped');
    const shown = findDrawingSnap(d, P(10.01, 2), { tolerance: TOL, includeHiddenLines: true });
    assert.equal(shown?.source.entityId, 80, 'hidden line indexed on request');
  });

  it('keeps an open-surface cut line', () => {
    const d = drawing([], [line(81, P(0, 0), P(4, 0), { category: 'cut', openSurfaceCut: true })]);
    assert.equal(findDrawingSnap(d, P(0.01, 0.01), { tolerance: TOL })?.mode, 'endpoint', 'open-surface cut indexed');
  });

  it('is safe on an empty drawing and on a bad tolerance', () => {
    const empty = drawing([]);
    assert.equal(getDrawingSnapIndex(empty).shapes.length, 0, 'no shapes');
    assert.equal(findDrawingSnap(empty, P(0, 0), { tolerance: TOL }), null, 'no snap');
    assert.equal(findDrawingSnap(drawing([splitWall()]), P(0, 0), { tolerance: 0 }), null, 'zero tolerance');
    assert.equal(findDrawingSnap(drawing([splitWall()]), P(NaN, 0), { tolerance: TOL }), null, 'NaN cursor');
  });

  it('builds the index once per drawing object', () => {
    const d = drawing([splitWall()]);
    const first = getDrawingSnapIndex(d);
    assert.equal(getDrawingSnapIndex(d) === first, true, 'memoised');
    assert.equal(getDrawingSnapIndex(d) === getDrawingSnapIndex(drawing([splitWall()])), false, 'new drawing, new index');
  });
});

describe('snapHitFit', () => {
  it('fits a center hit to the circle it came from, not to the curve', () => {
    const circle = { type: 'circle' as const, c: P(2, 3), r: 1.5 };
    assert.equal(snapHitFit(circle, 'center', P(2, 3)), 0);
    assert.ok(snapHitFit(circle, 'center', P(3.5, 3)) > 1);
  });
});
