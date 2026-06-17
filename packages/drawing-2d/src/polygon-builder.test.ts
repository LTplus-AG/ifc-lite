/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { PolygonBuilder } from './polygon-builder.js';
import type { CutSegment } from './types.js';

/** Build the 4 cut segments of an axis-aligned rectangle [x0,x1]×[y0,y1]. */
function rectSegments(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  entityId: number,
  color?: [number, number, number, number],
): CutSegment[] {
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const segs: CutSegment[] = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    segs.push({
      p0: { x: a[0], y: a[1], z: 0 },
      p1: { x: b[0], y: b[1], z: 0 },
      p0_2d: { x: a[0], y: a[1] },
      p1_2d: { x: b[0], y: b[1] },
      entityId,
      ifcType: 'IfcWall',
      modelIndex: 0,
      color,
    });
  }
  return segs;
}

const RED: [number, number, number, number] = [1, 0, 0, 1];
const BLUE: [number, number, number, number] = [0, 0, 1, 1];

describe('PolygonBuilder — material-layer colour split', () => {
  it('splits one entity into a polygon per layer colour, each carrying its colour', () => {
    // Two abutting layer slabs of the SAME wall (shared entityId), distinct
    // material colours — the section-cut shape of a 2-layer wall.
    const segments = [
      ...rectSegments(0, 0, 1, 1, 100, RED),
      ...rectSegments(1, 0, 2, 1, 100, BLUE),
    ];

    const polygons = new PolygonBuilder().buildPolygons(segments);

    expect(polygons).toHaveLength(2);
    for (const p of polygons) expect(p.entityId).toBe(100);

    const colors = polygons.map((p) => p.color).sort();
    expect(colors).toContainEqual(RED);
    expect(colors).toContainEqual(BLUE);
  });

  it('leaves a single-material entity as one colourless polygon (no fill override)', () => {
    // One colour ⇒ not multi-material ⇒ behave exactly as before: one polygon,
    // no `color` stamped, so the renderer keeps its per-ifcType / per-entity fill.
    const segments = rectSegments(0, 0, 1, 1, 200, RED);

    const polygons = new PolygonBuilder().buildPolygons(segments);

    expect(polygons).toHaveLength(1);
    expect(polygons[0].color).toBeUndefined();
  });

  it('groups same-colour layers but still yields a polygon per spatial loop', () => {
    // Finish material used on BOTH faces (layers 0 and 2) — same colour, two
    // disjoint rectangles. They share a colour bucket but the loop builder
    // separates them spatially into two polygons.
    const segments = [
      ...rectSegments(0, 0, 1, 1, 300, RED),
      ...rectSegments(5, 0, 6, 1, 300, RED),
      ...rectSegments(2, 0, 4, 1, 300, BLUE), // core in between
    ];

    const polygons = new PolygonBuilder().buildPolygons(segments);

    // 3 spatial loops total; the two RED ones are multi-material with the BLUE
    // core present, so all carry a colour.
    expect(polygons).toHaveLength(3);
    expect(polygons.filter((p) => p.color === RED || (p.color && p.color[0] === 1))).toHaveLength(2);
    for (const p of polygons) expect(p.color).toBeDefined();
  });
});
