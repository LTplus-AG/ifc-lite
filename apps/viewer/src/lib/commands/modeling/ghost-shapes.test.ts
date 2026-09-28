/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one ghost extruder every Model workspace command previews through
 * (#6232 M2.2): a concave slab outline must cap exactly its own area (a fan
 * would spill over the notch), and every face must point outward whichever
 * way the outline was clicked, or the ghost renders inside out.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec2 } from '@/lib/snap/types';
import { composeStoreyWorkplane } from './workplane.js';
import { prismGhostMesh, signedArea2, triangulateOutline } from './ghost-shapes.js';
import type { Vec3 } from './types.js';

const L_SHAPE: Vec2[] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]]; // area 12
const PLANE = composeStoreyWorkplane({
  modelId: 'm',
  spec: { kind: 'storey', storeyId: 1, offset: 0 },
  plan: { origin: [3, -2], axisX: [0.6, 0.8] }, // turned, off the origin
  elevation: 1.5,
  coordinateInfo: undefined,
  alignment: null,
  placement: { translation: [0, 0, 0], rotation: { angle: 0, pivot: [0, 0, 0] } },
});

const triArea = (a: Vec2, b: Vec2, c: Vec2) => ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;

describe('ghost shapes (#6232 M2.2)', () => {
  for (const [name, outline] of [['counter-clockwise', L_SHAPE], ['clockwise', [...L_SHAPE].reverse()]] as const) {
    it(`caps a concave ${name} outline with exactly its area, every triangle inside`, () => {
      const tris = triangulateOutline(outline);
      assert.equal(tris.length, outline.length - 2);
      const areas = tris.map(([a, b, c]) => triArea(outline[a], outline[b], outline[c]));
      assert.ok(areas.every((a) => a > 0), 'all counter-clockwise, none degenerate or flipped');
      assert.equal(areas.reduce((x, y) => x + y, 0), Math.abs(signedArea2(outline)) / 2);
      assert.equal(Math.abs(signedArea2(outline)) / 2, 12);
    });

    it(`every face of the ${name} prism points away from the solid`, () => {
      const mesh = prismGhostMesh(PLANE, outline, 0, 0.3, 7);
      assert.ok(mesh);
      assert.equal(mesh.expressId, 7);
      // Outward = the face normal points away from a point inside the solid. The
      // L is not convex, so test each face against the solid's point nearest it:
      // step inward from the face centroid and check that point is inside.
      const toLocal = (i: number): Vec3 => PLANE.renderToLocal([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
      const inside = ([x, y, z]: Vec3) => z > 0 && z < 0.3
        && ((x > 0 && x < 4 && y > 0 && y < 2) || (x > 0 && x < 2 && y > 0 && y < 4));
      for (let f = 0; f < mesh.indices.length; f += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => toLocal(mesh.indices[f + k] * 3));
        const centroid: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
        const nRender: Vec3 = [mesh.normals[mesh.indices[f] * 3], mesh.normals[mesh.indices[f] * 3 + 1], mesh.normals[mesh.indices[f] * 3 + 2]];
        const o = PLANE.renderToLocal([0, 0, 0]);
        const tip = PLANE.renderToLocal(nRender);
        const n: Vec3 = [tip[0] - o[0], tip[1] - o[1], tip[2] - o[2]];
        const step = 1e-3;
        const behind: Vec3 = [centroid[0] - n[0] * step, centroid[1] - n[1] * step, centroid[2] - n[2] * step];
        const ahead: Vec3 = [centroid[0] + n[0] * step, centroid[1] + n[1] * step, centroid[2] + n[2] * step];
        assert.ok(inside(behind) && !inside(ahead), `face ${f / 3} points outward`);
      }
    });
  }

  it('returns nothing for a degenerate outline or height', () => {
    assert.equal(prismGhostMesh(PLANE, [[0, 0], [1, 0], [2, 0]], 0, 1, 1), null, 'collinear');
    assert.equal(prismGhostMesh(PLANE, [[0, 0], [1, 0]], 0, 1, 1), null, 'two points');
    assert.equal(prismGhostMesh(PLANE, L_SHAPE, 0, 0, 1), null, 'no height');
    assert.equal(prismGhostMesh(PLANE, null, 0, 1, 1), null);
  });
});
