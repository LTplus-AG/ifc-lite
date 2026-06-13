/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  polyArea, pointInPoly, centroid, uniqueVerts, distToSeg, projectOnSeg,
  computeFit, zoomFit, sX, sY, wX, wY, type Pt,
} from './space-sketch-geometry.js';
import type { Room } from './space-plate-session.js';

const room = (outline: Pt[]): Room => ({ face: 0, area: polyArea(outline), simple: true, outline });
const rect: Pt[] = [[0, 0], [4, 0], [4, 3], [0, 3]];

describe('polyArea', () => {
  it('is winding-independent (absolute)', () => {
    assert.strictEqual(polyArea(rect), 12);
    assert.strictEqual(polyArea([...rect].reverse()), 12);
  });
});

describe('pointInPoly', () => {
  it('detects inside vs outside', () => {
    assert.strictEqual(pointInPoly(2, 1.5, rect), true);
    assert.strictEqual(pointInPoly(5, 1.5, rect), false);
  });
});

describe('centroid', () => {
  it('averages the points', () => {
    assert.deepStrictEqual(centroid(rect), [2, 1.5]);
  });
});

describe('uniqueVerts', () => {
  it('dedupes shared corners across rooms', () => {
    const a = room([[0, 0], [4, 0], [4, 3], [0, 3]]);
    const b = room([[4, 0], [8, 0], [8, 3], [4, 3]]); // shares (4,0) and (4,3)
    assert.strictEqual(uniqueVerts([a, b]).length, 6, 'two shared corners collapse 8 → 6');
  });
});

describe('distToSeg / projectOnSeg', () => {
  it('measures perpendicular distance and clamps the projection', () => {
    assert.ok(Math.abs(distToSeg(5, 1, 0, 0, 10, 0) - 1) < 1e-9);
    assert.deepStrictEqual(projectOnSeg([5, 1], [0, 0], [10, 0]), [5, 0]);
    // Past the end → clamps to the endpoint.
    assert.deepStrictEqual(projectOnSeg([20, 5], [0, 0], [10, 0]), [10, 0]);
  });
});

describe('computeFit / transforms', () => {
  it('frames rooms centred and round-trips world↔screen', () => {
    const f = computeFit([room(rect)], 580, 460);
    // The room centre (2, 1.5) maps to the canvas centre.
    assert.ok(Math.abs(sX(f, 2) - 290) < 1e-6);
    assert.ok(Math.abs(sY(f, 1.5) - 230) < 1e-6);
    // world → screen → world is identity.
    assert.ok(Math.abs(wX(f, sX(f, 3.3)) - 3.3) < 1e-9);
    assert.ok(Math.abs(wY(f, sY(f, 2.1)) - 2.1) < 1e-9);
  });

  it('falls back to a sane default for an empty scene', () => {
    const f = computeFit([], 580, 460);
    assert.strictEqual(f.scale, 1);
  });

  it('zoomFit keeps the anchor point fixed on screen', () => {
    const f = computeFit([room(rect)], 580, 460);
    const z = zoomFit(f, 2, 100, 200);
    assert.ok(Math.abs(sX(z, wX(f, 100)) - 100) < 1e-6, 'anchor X stays put');
    assert.ok(Math.abs(sY(z, wY(f, 200)) - 200) < 1e-6, 'anchor Y stays put');
    assert.strictEqual(z.scale, f.scale * 2);
  });
});
