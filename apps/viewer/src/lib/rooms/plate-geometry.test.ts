/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  polyArea, pointInPoly, distToSeg, projectOnSeg,
  zoomFit, sX, sY, wX, wY, type Fit, type Pt,
} from './plate-geometry.js';

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

describe('distToSeg / projectOnSeg', () => {
  it('measures perpendicular distance and clamps the projection', () => {
    assert.ok(Math.abs(distToSeg(5, 1, 0, 0, 10, 0) - 1) < 1e-9);
    assert.deepStrictEqual(projectOnSeg([5, 1], [0, 0], [10, 0]), [5, 0]);
    // Past the end → clamps to the endpoint.
    assert.deepStrictEqual(projectOnSeg([20, 5], [0, 0], [10, 0]), [10, 0]);
  });
});

const FIT: Fit = { scale: 20, offX: 36, offY: 304 };

describe('transforms', () => {
  it('round-trips world↔screen', () => {
    const f = FIT;
    // world → screen → world is identity.
    assert.ok(Math.abs(wX(f, sX(f, 3.3)) - 3.3) < 1e-9);
    assert.ok(Math.abs(wY(f, sY(f, 2.1)) - 2.1) < 1e-9);
  });

  it('zoomFit keeps the anchor point fixed on screen', () => {
    const f = FIT;
    const z = zoomFit(f, 2, 100, 200);
    assert.ok(Math.abs(sX(z, wX(f, 100)) - 100) < 1e-6, 'anchor X stays put');
    assert.ok(Math.abs(sY(z, wY(f, 200)) - 200) < 1e-6, 'anchor Y stays put');
    assert.strictEqual(z.scale, f.scale * 2);
  });
});
