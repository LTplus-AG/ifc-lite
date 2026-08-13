/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { contactClusters, type Mesh } from './index.js';

/** Axis-aligned box [min..max] as a triangulated mesh (12 triangles). */
function box(id: string, min: [number, number, number], max: [number, number, number]): Mesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 5, 1], [0, 4, 5],
    [1, 6, 2], [1, 5, 6], [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  return { id, positions: new Float64Array(v.flat()), indices: new Uint32Array(faces.flat()) };
}

describe('contactClusters (contact interface geometry)', () => {
  it('reports the shared faces of two overlapping boxes as surface clusters', () => {
    // A [0,1]^3 and B shifted +0.5 in x overlap in x[0.5,1]; the coincident
    // y/z faces over that range are the contact patches.
    const a = box('A', [0, 0, 0], [1, 1, 1]);
    const b = box('B', [0.5, 0, 0], [1.5, 1, 1]);
    const clusters = contactClusters(a, b);
    const surfaces = clusters.filter((c) => c.kind === 'surface');
    expect(surfaces.length).toBeGreaterThanOrEqual(1);
    // Each coincident face over x[0.5,1] is a 0.5 x 1 patch (area 0.5).
    const totalArea = surfaces.reduce((s, c) => s + c.area_m2, 0);
    expect(totalArea).toBeGreaterThan(0.4);
    // Surface clusters carry a real boundary polygon (>= a triangle), not a point.
    for (const c of surfaces) expect(c.boundary.length).toBeGreaterThanOrEqual(3);
  });

  it('returns no contact for clearly separated boxes', () => {
    const a = box('A', [0, 0, 0], [1, 1, 1]);
    const b = box('B', [5, 5, 5], [6, 6, 6]);
    expect(contactClusters(a, b)).toEqual([]);
  });

  it('reports a line contact for two perpendicular bars that cross', () => {
    const a = box('A', [-5, -0.5, -0.5], [5, 0.5, 0.5]); // along X
    const b = box('B', [-0.5, -5, -0.5], [0.5, 5, 0.5]); // along Y
    const clusters = contactClusters(a, b);
    // The crossing yields line contacts along the shared edges (and possibly
    // coincident top/bottom faces); at minimum some contact is reported.
    expect(clusters.length).toBeGreaterThan(0);
    const lines = clusters.filter((c) => c.kind === 'line');
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  // Geometry is ingested from f32 buffers throughout this codebase, so two
  // elements authored to be exactly flush can round to *adjacent* — not
  // bit-identical — f32 values at their shared boundary once far from the
  // origin. `narrowPhase`'s default `planeEps` used to be a fixed 1e-6,
  // which is below the f32 ULP above ~8.4 m and reaches ~4.9e-4 at 5 km, so
  // it misread that rounding noise as a genuine gap and dropped the shared
  // face entirely instead of reporting it. (follow-up to #2594, which fixed
  // the equivalent defect in the narrow-phase penetration-depth floor.)
  describe('scale-relative planeEps (flush boundary at large world coordinates)', () => {
    /** Bump an f32 value by exactly one ULP: adjacent-but-not-identical
     * float32 coordinates, as two independently authored elements meeting
     * at a "flush" boundary actually produce. */
    function nextF32(x: number): number {
      const buf = new Float32Array([x]);
      new Uint32Array(buf.buffer)[0] += 1;
      return buf[0] as number;
    }

    /** Two boxes sharing a face at world x = offset + 0.5, where B's side of
     * the boundary is one f32 ULP off A's (see `nextF32`) — the mechanism
     * #2594 measured on Infra-Bridge.ifc (20 pairs bit-identical at the f32
     * ULP for their coordinate magnitude). */
    function flushBoxesAtOffset(offset: number): { a: Mesh; b: Mesh } {
      const xA = Math.fround(offset + 0.5);
      const xB = nextF32(xA);
      return {
        a: box('A', [offset, 0, 0], [xA, 1, 1]),
        b: box('B', [xB, 0, 0], [offset + 1, 1, 1]),
      };
    }

    it('RED: a fixed planeEps=1e-6 drops the shared face at 5 km from the origin', () => {
      const { a, b } = flushBoxesAtOffset(5000);
      const clusters = contactClusters(a, b, { planeEps: 1e-6 });
      expect(clusters.some((c) => c.kind === 'surface')).toBe(false);
    });

    it('GREEN: the default (scale-relative) planeEps recovers the shared face at 5 km from the origin', () => {
      const { a, b } = flushBoxesAtOffset(5000);
      const clusters = contactClusters(a, b);
      expect(clusters.some((c) => c.kind === 'surface')).toBe(true);
    });

    it('GREEN: also recovers it at 50 km from the origin', () => {
      const { a, b } = flushBoxesAtOffset(50_000);
      const clusters = contactClusters(a, b);
      expect(clusters.some((c) => c.kind === 'surface')).toBe(true);
    });

    it('unchanged near the origin: the new default matches the old fixed 1e-6 exactly, on the fixtures already used above', () => {
      // Same fixtures as the very first test in this file (overlapping unit
      // boxes near the origin) and the perpendicular-bars test: near the
      // origin the f32 ULP is far below 1e-6, so the scale-relative default
      // and the old fixed constant must agree bit-for-bit.
      const cases: Array<[Mesh, Mesh]> = [
        [box('A', [0, 0, 0], [1, 1, 1]), box('B', [0.5, 0, 0], [1.5, 1, 1])],
        [box('A', [-5, -0.5, -0.5], [5, 0.5, 0.5]), box('B', [-0.5, -5, -0.5], [0.5, 5, 0.5])],
      ];
      for (const [a, b] of cases) {
        const withDefault = contactClusters(a, b);
        const withFixed = contactClusters(a, b, { planeEps: 1e-6 });
        expect(withDefault).toEqual(withFixed);
      }
    });
  });
});
