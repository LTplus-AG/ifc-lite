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
});
