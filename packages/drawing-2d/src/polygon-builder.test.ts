/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { PolygonBuilder } from './polygon-builder.js';
import { polygonSignedArea, isCounterClockwise } from './math.js';
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

describe('PolygonBuilder — hole containment and winding (classifyLoops)', () => {
  /**
   * A slab section with a through-opening: one outer ring and one smaller
   * ring fully inside it, same entity, single material (colourless).
   * `classifyLoops` must classify the smaller ring as a HOLE of the larger
   * one — and (undocumented invariant, previously untested — see the
   * mutation this regression kills below) the outer ring must come back CCW
   * and the hole CW, i.e. OPPOSITE winding.
   *
   * The CONTAINMENT half is what every downstream consumer reads:
   * `packages/renderer/src/section-2d-overlay.ts` feeds
   * `polygon.outer`/`polygon.holes` straight into `triangulateRings()` for
   * the 3D cut-face fill, while `Drawing2DCanvas` and `svg-exporter.ts`
   * emit each ring as its own subpath and fill with `evenodd` — which
   * decides fill from crossing parity and ignores winding entirely.
   *
   * The WINDING half is a producer-side invariant rather than something a
   * consumer depends on: since #2516 the renderer re-normalises windings
   * itself, so a same-wound hole no longer breaks the 3D cap. It is still
   * pinned here because `classifyLoops` promising an orientation and then
   * not delivering it is a silent lie to anything that reads the loops
   * directly. Swapping `ensureCCW`/`ensureCW` for the
   * outer ring in `classifyLoops` (`ensureCCW(outer.points)` →
   * `ensureCW(outer.points)`) leaves both rings wound the SAME way; no
   * existing test in this file or `polygon-builder-opening.test.ts` builds
   * a contained hole, so that mutation survives the full suite.
   */
  it('classifies a contained inner ring as a hole, wound opposite the outer ring', () => {
    const segments = [
      ...rectSegments(0, 0, 10, 10, 500), // outer boundary
      ...rectSegments(4, 4, 6, 6, 500),   // fully-contained opening
    ];

    const polygons = new PolygonBuilder().buildPolygons(segments);

    expect(polygons).toHaveLength(1);
    const { outer, holes } = polygons[0].polygon;
    expect(holes).toHaveLength(1);

    expect(isCounterClockwise(outer)).toBe(true);
    expect(isCounterClockwise(holes[0])).toBe(false);
    expect(Math.abs(polygonSignedArea(outer))).toBeCloseTo(100, 5);
    expect(Math.abs(polygonSignedArea(holes[0]))).toBeCloseTo(4, 5);
  });

  /**
   * An island (e.g. a mullion cross-section, or a column stub) fully
   * contained inside a hole (a window opening, or a shaft) must be promoted
   * to its OWN solid outer polygon — not folded into the outer wall as a
   * second hole. `classifyLoops` previously tested every ring's containment
   * only against the top-level outer, so anything geometrically inside the
   * outer boundary — at ANY nesting depth — was classified as a hole of it.
   * That silently turned the island into void, i.e. the mullion/column
   * would render as an empty gap in the drawing instead of solid material.
   */
  it('promotes an island nested inside a hole to its own solid polygon, not a second hole of the outer', () => {
    const segments = [
      ...rectSegments(0, 0, 10, 10, 500), // outer wall boundary
      ...rectSegments(2, 2, 8, 8, 500),   // window opening (hole)
      ...rectSegments(4, 4, 6, 6, 500),   // mullion cross-section (island) inside the opening
    ];

    const polygons = new PolygonBuilder().buildPolygons(segments);

    expect(polygons).toHaveLength(2);

    const outerPoly = polygons.find(
      (p) => Math.abs(polygonSignedArea(p.polygon.outer)) > 50,
    )!;
    const islandPoly = polygons.find(
      (p) => Math.abs(polygonSignedArea(p.polygon.outer)) < 50,
    )!;

    // The outer wall keeps exactly the window opening as its hole — the
    // island must NOT appear as a second hole here.
    expect(outerPoly.polygon.holes).toHaveLength(1);
    expect(Math.abs(polygonSignedArea(outerPoly.polygon.outer))).toBeCloseTo(100, 5);
    expect(Math.abs(polygonSignedArea(outerPoly.polygon.holes[0]))).toBeCloseTo(36, 5);

    // The island is its own solid polygon (no holes), wound CCW like any
    // other outer boundary.
    expect(islandPoly.polygon.holes).toHaveLength(0);
    expect(isCounterClockwise(islandPoly.polygon.outer)).toBe(true);
    expect(Math.abs(polygonSignedArea(islandPoly.polygon.outer))).toBeCloseTo(4, 5);
  });

  /**
   * Regression for issue #2364: the viewer hung forever inside
   * `classifyLoops` on real-world section cuts with overlapping loops.
   *
   * Containment is decided by a SINGLE point (`isLoopContainedIn` tests only
   * `inner[0]`), so two partially-overlapping loops whose start vertices each
   * lie inside the OTHER loop "contain" each other. The nearest-ancestor
   * search introduced by #2331 then produced parent[A] = B and parent[B] = A,
   * and the nesting-depth walk (`p = parent[p]`) cycled forever — a
   * deterministic hang on any model whose cut yields such loops (coplanar
   * duplicate faces in dense tessellated geometry are a common source).
   *
   * The two equal-area squares below overlap diagonally; each ring is ordered
   * so its first vertex sits strictly inside the other square. The only thing
   * this test truly pins is TERMINATION — plus a sane classification: one loop
   * becomes the outer, the other its hole, never two mutual parents.
   */
  it('terminates on mutually-overlapping loops whose start points contain each other (#2364)', () => {
    const ring = (corners: [number, number][], entityId: number): CutSegment[] =>
      corners.map((a, i) => {
        const b = corners[(i + 1) % corners.length];
        return {
          p0: { x: a[0], y: a[1], z: 0 },
          p1: { x: b[0], y: b[1], z: 0 },
          p0_2d: { x: a[0], y: a[1] },
          p1_2d: { x: b[0], y: b[1] },
          entityId,
          ifcType: 'IfcWall',
          modelIndex: 0,
          color: undefined,
        };
      });

    const segments = [
      // Square [1,5]×[1,5], first vertex (5,5) — strictly inside the second square.
      ...ring([[5, 5], [1, 5], [1, 1], [5, 1]], 700),
      // Square [2,6]×[2,6], first vertex (2,2) — strictly inside the first square.
      ...ring([[2, 2], [6, 2], [6, 6], [2, 6]], 700),
    ];

    const polygons = new PolygonBuilder().buildPolygons(segments);

    // Equal areas make the outer/hole tie-break an implementation detail;
    // what matters is one solid polygon with the other ring as its hole.
    expect(polygons).toHaveLength(1);
    const { outer, holes } = polygons[0].polygon;
    expect(holes).toHaveLength(1);
    expect(Math.abs(polygonSignedArea(outer))).toBeCloseTo(16, 5);
    expect(Math.abs(polygonSignedArea(holes[0]))).toBeCloseTo(16, 5);
  });
});
