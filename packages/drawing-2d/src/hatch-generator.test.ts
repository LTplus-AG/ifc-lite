/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { HatchGenerator } from './hatch-generator.js';
import type { DrawingPolygon, Point2D } from './types.js';

function polygonOf(entityId: number, outer: Point2D[], holes: Point2D[][] = []): DrawingPolygon {
  return {
    polygon: { outer, holes },
    entityId,
    ifcType: 'IfcWall',
    modelIndex: 0,
    isCut: true,
  };
}

function assertBoundedInX(lines: { line: { start: Point2D; end: Point2D } }[], min: number, max: number): void {
  for (const l of lines) {
    expect(l.line.start.x).toBeGreaterThanOrEqual(min - 1e-6);
    expect(l.line.start.x).toBeLessThanOrEqual(max + 1e-6);
    expect(l.line.end.x).toBeGreaterThanOrEqual(min - 1e-6);
    expect(l.line.end.x).toBeLessThanOrEqual(max + 1e-6);
  }
}

// Rectangle [0,10]x[0,10] with a downward spike notch cut into the TOP edge,
// reaching down to touch y=5 at a single vertex without crossing below it.
// The polygon interior at y=5 spans the FULL width [0,10] — the notch only
// removes area above y=5.
const spikeOuter: Point2D[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 6, y: 10 },
  { x: 5, y: 5 }, // tangent vertex: touches the y=5 hatch line without crossing it
  { x: 4, y: 10 },
  { x: 0, y: 10 },
];

describe('HatchGenerator', () => {
  it('keeps every hatch segment inside the polygon bounds (tangent-vertex spike)', () => {
    const gen = new HatchGenerator();
    const drawingPolygon = polygonOf(1, spikeOuter);

    // angle=90 => hatch lines run horizontally (parallel to x), stepping in y.
    // The sweep starts exactly at the polygon's bbox min (y=0, the bottom
    // edge) and includes y=5 (the tangent vertex) as an exact step.
    const result = gen.generateHatch(drawingPolygon, 100, {
      type: 'diagonal',
      spacing: 1,
      angle: 90,
    });

    // Every emitted hatch segment must lie within the polygon's bounding box
    // — a segment escaping the bbox is unambiguously outside the polygon,
    // since the polygon is entirely contained in [0,10]x[0,10]. Before the
    // fix, the row through the tangent vertex (5,5) produced a segment
    // running to x=-21.2 — dozens of units outside the shape.
    assertBoundedInX(result.lines, 0, 10);
  });

  it('fully hatches the row at the tangent vertex (no gap, no leak)', () => {
    const gen = new HatchGenerator();
    const drawingPolygon = polygonOf(1, spikeOuter);

    const result = gen.generateHatch(drawingPolygon, 100, {
      type: 'diagonal',
      spacing: 1,
      angle: 90,
    });

    const atY5 = result.lines.filter((l) => Math.abs(l.line.start.y - 5) < 1e-6);
    const totalLenAtY5 = atY5.reduce((s, l) => s + Math.abs(l.line.end.x - l.line.start.x), 0);
    // The interior span at y=5 is the full width, ~10.
    expect(totalLenAtY5).toBeCloseTo(10, 3);
  });

  it('does not leak when a hatch row runs exactly along a straight boundary edge', () => {
    const gen = new HatchGenerator();
    const drawingPolygon = polygonOf(1, spikeOuter);

    const result = gen.generateHatch(drawingPolygon, 100, {
      type: 'diagonal',
      spacing: 1,
      angle: 90,
    });

    // The very first sweep row (y=0) is collinear with the polygon's own
    // bottom edge. Before the fix it leaked to x=-21.2. The tie-break puts a
    // line lying exactly along a ring edge on the OUTSIDE of that ring, so
    // the row is now dropped outright rather than emitted as a boundary
    // sliver — assert that, not just that nothing escaped the bbox.
    assertBoundedInX(result.lines, 0, 10);
    const atY0 = result.lines.filter((l) => Math.abs(l.line.start.y) < 1e-6);
    expect(atY0).toHaveLength(0);
  });

  it('does not lose a crossing when a whole boundary edge is collinear with the hatch row', () => {
    const gen = new HatchGenerator();
    // Trapezoid whose TOP edge lies exactly on the y=8 hatch row. Both top
    // vertices are nominally on the row, so their side values are
    // floating-point noise of either sign: the edge between them reads as a
    // crossing by side but as parallel to a cross-product intersection
    // solve, and losing it there inverts parity for the rest of the row.
    const outer: Point2D[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 7, y: 8 },
      { x: 3, y: 8 },
    ];
    const result = gen.generateHatch(polygonOf(4, outer), 100, {
      type: 'diagonal',
      spacing: 1,
      angle: 90,
    });

    assertBoundedInX(result.lines, 0, 10);
    const atY8 = result.lines.filter((l) => Math.abs(l.line.start.y - 8) < 1e-6);
    // The shape at y=8 is the top edge itself, x in [3,7]. Before the fix
    // this row ran to x=-19.2, ~19 units clear of the trapezoid.
    expect(atY8.length).toBeGreaterThan(0);
    assertBoundedInX(atY8, 3, 7);
  });

  it('resolves a genuine pass-through vertex as a real crossing (rhombus)', () => {
    const gen = new HatchGenerator();
    // A rhombus whose left/right vertices sit exactly on the y=5 hatch row,
    // with their neighbours on OPPOSITE sides of it (unlike the tangent
    // spike above) — a genuine crossing, not a touch. The interior span at
    // y=5 is the rhombus's full diagonal width, x in [0,10].
    const outer: Point2D[] = [
      { x: 0, y: 5 },
      { x: 5, y: 0 },
      { x: 10, y: 5 },
      { x: 5, y: 10 },
    ];
    const drawingPolygon = polygonOf(3, outer);

    const result = gen.generateHatch(drawingPolygon, 100, {
      type: 'diagonal',
      spacing: 1,
      angle: 90,
    });

    assertBoundedInX(result.lines, 0, 10);
    const atY5 = result.lines.filter((l) => Math.abs(l.line.start.y - 5) < 1e-6);
    const totalLenAtY5 = atY5.reduce((s, l) => s + Math.abs(l.line.end.x - l.line.start.x), 0);
    expect(totalLenAtY5).toBeCloseTo(10, 3);
  });

  it('keeps the interior run on a row that lies along a hole edge', () => {
    const gen = new HatchGenerator();
    // Two holes abutting on y=6, so the y=6 hatch row is flush with the top
    // edge of the lower one AND the bottom edge of the upper one. Nothing
    // about that touches x < 4, which is plain interior 4 units wide.
    const outer: Point2D[] = [
      { x: 0, y: 0 },
      { x: 11, y: 0 },
      { x: 11, y: 13 },
      { x: 0, y: 13 },
    ];
    const lower: Point2D[] = [
      { x: 4, y: 3 },
      { x: 7, y: 3 },
      { x: 7, y: 6 },
      { x: 4, y: 6 },
    ];
    const upper: Point2D[] = [
      { x: 4, y: 6 },
      { x: 8, y: 6 },
      { x: 8, y: 8 },
      { x: 4, y: 8 },
    ];

    const result = gen.generateHatch(polygonOf(5, outer, [lower, upper]), 100, {
      type: 'diagonal',
      spacing: 1,
      angle: 90,
    });

    const atY6 = result.lines
      .filter((l) => Math.abs(l.line.start.y - 6) < 1e-6)
      .map((l) => [
        Math.min(l.line.start.x, l.line.end.x),
        Math.max(l.line.start.x, l.line.end.x),
      ] as const)
      .sort((a, b) => a[0] - b[0]);

    // x in [0,4] and x in [7,11] are interior; x in [4,7] is the lower hole,
    // whose FAR edge the row lies on, so it is subtracted. Deciding the row
    // by ray-casting its start point instead of by the side test threw the
    // whole row away here, losing the [0,4] run — genuine interior two units
    // clear of any boundary — because the row's start read as inside the
    // upper hole, which it only touches.
    expect(atY6).toHaveLength(2);
    expect(atY6[0][0]).toBeCloseTo(0, 9);
    expect(atY6[0][1]).toBeCloseTo(4, 9);
    expect(atY6[1][0]).toBeCloseTo(7, 9);
    expect(atY6[1][1]).toBeCloseTo(11, 9);
  });

  it('still subtracts a hole whose edge is flush with the hatch line (regression)', () => {
    const gen = new HatchGenerator();
    // 10x10 square with a 4x4 hole whose top edge sits exactly at y=5.
    const outer: Point2D[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const hole: Point2D[] = [
      { x: 3, y: 1 },
      { x: 7, y: 1 },
      { x: 7, y: 5 },
      { x: 3, y: 5 },
    ].reverse();
    const drawingPolygon = polygonOf(2, outer, [hole]);

    const result = gen.generateHatch(drawingPolygon, 100, {
      type: 'diagonal',
      spacing: 1,
      angle: 90,
    });

    assertBoundedInX(result.lines, 0, 10);

    // The row at y=5 runs exactly along the hole's top edge. Pin that the
    // hole is still cut out of it: a bbox check alone passes even when the
    // row is painted straight across the void, because the void is inside
    // the outer square.
    const atY5 = result.lines
      .filter((l) => Math.abs(l.line.start.y - 5) < 1e-6)
      .map((l) => [
        Math.min(l.line.start.x, l.line.end.x),
        Math.max(l.line.start.x, l.line.end.x),
      ] as const);
    expect(atY5.length).toBeGreaterThan(0);
    for (const [lo, hi] of atY5) {
      // Overlap of the emitted interval with the hole's span x in [3,7].
      expect(Math.min(hi, 7) - Math.max(lo, 3)).toBeLessThanOrEqual(1e-6);
    }
  });
});
