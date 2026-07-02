/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { PolygonBuilder } from './polygon-builder.js';
import { polygonSignedArea } from './math.js';
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

describe('PolygonBuilder — open-band reconstruction (cap-free layer slabs)', () => {
  /** The 3 cut segments of a layer band whose interface side (x = `xCut`) is
   *  OPEN — the section shape of a material-layer slab now that the slicer no
   *  longer caps the interface plane. `outerX` is the band's wall-face side. */
  function openBand(
    outerX: number,
    xCut: number,
    entityId: number,
    color: [number, number, number, number],
  ): CutSegment[] {
    const mk = (ax: number, ay: number, bx: number, by: number): CutSegment => ({
      p0: { x: ax, y: ay, z: 0 }, p1: { x: bx, y: by, z: 0 },
      p0_2d: { x: ax, y: ay }, p1_2d: { x: bx, y: by },
      entityId, ifcType: 'IfcWall', modelIndex: 0, color,
    });
    return [
      mk(outerX, 0, outerX, 1),   // wall-face edge
      mk(outerX, 0, xCut, 0),     // bottom strip (open end at xCut)
      mk(outerX, 1, xCut, 1),     // top strip    (open end at xCut)
    ];
  }

  it('closes each open band at the interface chord → one filled polygon per layer', () => {
    // 2-layer wall sectioned: RED band [0,1] open at x=1, BLUE band [2,1] open at
    // x=1 — the shared interface. A forward-only loop builder strands these and
    // emits nothing; the bidirectional builder assembles each U and the implicit
    // head→tail chord (x=1) re-creates the interface the removed cap used to draw.
    const segments = [
      ...openBand(0, 1, 100, RED),
      ...openBand(2, 1, 100, BLUE),
    ];

    const polygons = new PolygonBuilder().buildPolygons(segments);

    expect(polygons).toHaveLength(2);
    const colors = polygons.map((p) => p.color);
    expect(colors).toContainEqual(RED);
    expect(colors).toContainEqual(BLUE);
    // Each layer is a unit square (area 1): the open contours were closed, not dropped.
    for (const p of polygons) {
      const area = Math.abs(polygonSignedArea(p.polygon.outer));
      expect(area).toBeCloseTo(1.0, 5);
    }
  });

  it('fills an INTERIOR layer of a 3+ layer wall (disconnected end strips stitched)', () => {
    // Wall x∈[0,10], thickness split into 3 layers: outer [0,1], CORE [1,3],
    // inner [3,4]. The core band has no wall face — its plan section is only the
    // two END strips (x=0 and x=10), disconnected. A per-band loop builder drops
    // it (the regression Codex flagged on #1311); stitching the fragments at the
    // y=1 and y=3 interface chords recovers the core fill.
    const seg = (
      ax: number, ay: number, bx: number, by: number,
      c: [number, number, number, number],
    ): CutSegment => ({
      p0: { x: ax, y: ay, z: 0 }, p1: { x: bx, y: by, z: 0 },
      p0_2d: { x: ax, y: ay }, p1_2d: { x: bx, y: by },
      entityId: 1, ifcType: 'IfcWall', modelIndex: 0, color: c,
    });
    const GREEN: [number, number, number, number] = [0, 1, 0, 1];
    const segments = [
      // outer RED band [0,1]: wall face + 2 end strips (a closeable U)
      seg(0, 0, 10, 0, RED), seg(0, 0, 0, 1, RED), seg(10, 0, 10, 1, RED),
      // CORE GREEN band [1,3]: ONLY the two end strips — disconnected
      seg(0, 1, 0, 3, GREEN), seg(10, 1, 10, 3, GREEN),
      // inner BLUE band [3,4]: wall face + 2 end strips
      seg(0, 4, 10, 4, BLUE), seg(0, 3, 0, 4, BLUE), seg(10, 3, 10, 4, BLUE),
    ];

    const polygons = new PolygonBuilder().buildPolygons(segments);

    expect(polygons).toHaveLength(3);
    const area = (c: [number, number, number, number]) =>
      Math.abs(polygonSignedArea(polygons.find((p) => p.color === c)!.polygon.outer));
    expect(area(GREEN)).toBeCloseTo(20.0, 5); // core: 10 (length) × 2 (thickness)
    expect(area(RED)).toBeCloseTo(10.0, 5);
    expect(area(BLUE)).toBeCloseTo(10.0, 5);
  });
});
