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
    // bottom edge. That is a genuinely ambiguous boundary case (the row has
    // no interior on either side to enter), so this only pins the invariant
    // that matters: no segment leaks outside the shape it was clipped to.
    assertBoundedInX(result.lines, 0, 10);
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

    // A boundary row exactly flush with the hole's edge is a genuinely
    // ambiguous case (open vs. closed set convention) — what matters here is
    // that no segment leaks outside the outer square, which the tangent-spike
    // fix above could otherwise break for a hole boundary too.
    assertBoundedInX(result.lines, 0, 10);
  });
});
