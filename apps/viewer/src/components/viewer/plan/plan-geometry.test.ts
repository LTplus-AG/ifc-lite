/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The plan's pure maths (charter #6232 M2.4): the click pick (smallest
 * outline wins, holes are not inside), the grid's fade-out threshold, the
 * framing of an empty storey, the cut linework the plan snaps to, and the
 * ghost footprint fallback.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec2 } from '@/lib/snap/types';
import type { Workplane } from '@/lib/commands/modeling/types';
import { sX, sY } from '@/lib/rooms/plate-geometry';
import { GRID_MIN_PX_PER_M, fitPlan, pickPlanEntity, planGrid, screenToLocal } from './plan-fit';
import { planCutLinework } from './plan-cut-source';
import { convexHull, ghostFootprints } from './plan-ghost';
import type { PlanCutPolygon } from './usePlanCut';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const poly = (entityId: number, outer: Vec2[], holes: Vec2[][] = []): PlanCutPolygon => ({ entityId, ifcType: 'IfcWall', outer, holes });

describe('pickPlanEntity', () => {
  const slab = poly(1, rect(0, 0, 10, 10));
  const wall = poly(2, rect(2, 2, 6, 3));
  const ring = poly(3, rect(20, 0, 30, 10), [rect(22, 2, 28, 8)]);

  it('picks the smallest outline containing the point, whatever the draw order', () => {
    assert.equal(pickPlanEntity([slab, wall], [3, 2.5]), 2);
    assert.equal(pickPlanEntity([wall, slab], [3, 2.5]), 2);
    assert.equal(pickPlanEntity([slab, wall], [8, 8]), 1);
  });

  it('a point in a hole is not inside, and empty space picks nothing', () => {
    assert.equal(pickPlanEntity([ring], [25, 5]), null);
    assert.equal(pickPlanEntity([ring], [21, 5]), 3);
    assert.equal(pickPlanEntity([slab], [-1, 5]), null);
  });
});

describe('planGrid', () => {
  it('is not drawn below the pixels-per-metre threshold', () => {
    assert.equal(planGrid({ scale: GRID_MIN_PX_PER_M - 0.5, offX: 0, offY: 0 }, 800, 600), null);
    assert.ok(planGrid({ scale: GRID_MIN_PX_PER_M, offX: 0, offY: 0 }, 800, 600));
  });

  it('draws 1 m lines at their screen positions, fading in', () => {
    const fit = { scale: 50, offX: 10, offY: 590 };
    const grid = planGrid(fit, 800, 600)!;
    assert.equal(grid.spacing, 1);
    assert.equal(grid.opacity, 1);
    assert.deepEqual(grid.xs.slice(0, 3), [10, 60, 110], 'x = 0, 1, 2 m');
    assert.ok(grid.ys.includes(590), 'y = 0 m');
    const faint = planGrid({ scale: 12, offX: 0, offY: 0 }, 800, 600)!;
    assert.ok(faint.opacity > 0 && faint.opacity < 1);
  });
});

describe('fitPlan / screenToLocal', () => {
  it('frames an empty storey round its origin, y up', () => {
    const fit = fitPlan([], [], [], 800, 600);
    const centre = screenToLocal(fit, 400, 300);
    assert.ok(Math.abs(centre[0]) < 1e-9 && Math.abs(centre[1]) < 1e-9, 'the origin is centred');
    assert.ok(sY(fit, 1) < sY(fit, 0), 'local +y is up the screen');
    const back = screenToLocal(fit, sX(fit, 2.5), sY(fit, -1.5));
    assert.deepEqual(back.map((v) => +v.toFixed(9)), [2.5, -1.5]);
  });

  it('fills a narrow pane with a small margin (#6232 M2.4 review: Fit left the storey at half the pane)', () => {
    const fit = fitPlan([poly(1, rect(0, 0, 12, 10))], [], [], 308, 895);
    const width = sX(fit, 12) - sX(fit, 0);
    assert.ok(width / 308 >= 0.9, `the storey spans ${(width / 308).toFixed(2)} of the pane width`);
    assert.ok(sX(fit, 0) >= 12 - 1e-9 && sX(fit, 12) <= 308 - 12 + 1e-9, 'and keeps a margin');
  });

  it('frames the cut and the wall axes together', () => {
    const fit = fitPlan([poly(1, rect(0, 0, 4, 1))], [], [{ expressId: 9, a: [0, 5], b: [4, 5] }], 800, 600);
    for (const p of [[0, 0], [4, 5]] as Vec2[]) {
      const x = sX(fit, p[0]), y = sY(fit, p[1]);
      assert.ok(x >= 0 && x <= 800 && y >= 0 && y <= 600, `${p} is on screen`);
    }
  });
});

describe('planCutLinework', () => {
  it('snaps to outline edges (holes too) and visible projection lines only', () => {
    const lines = planCutLinework(
      [poly(1, rect(0, 0, 2, 1), [rect(0.5, 0.25, 1, 0.75)])],
      [
        { a: [5, 0], b: [6, 0], entityId: 2, category: 'projection', hidden: false },
        { a: [7, 0], b: [8, 0], entityId: 2, category: 'projection', hidden: true },
      ],
    );
    assert.equal(lines.segments?.length, 4 + 4 + 1);
    assert.equal(lines.midpoints, true);
    assert.ok(!lines.segments?.some(([a]) => a[0] === 7), 'occluded lines are not snap targets');
  });
});

describe('ghost footprint', () => {
  it('convexHull drops interior and collinear points', () => {
    const hull = convexHull([[0, 0], [2, 0], [1, 0], [2, 2], [0, 2], [1, 1]]);
    assert.equal(hull.length, 4);
    assert.ok(!hull.some((p) => p[0] === 1), 'no interior or collinear point survives');
  });

  it('maps each ghost mesh onto the workplane before wrapping it', () => {
    // A plane whose local (x, y) is render (x, −z), like a storey plan.
    const plane = { renderToLocal: (p: readonly number[]) => [p[0], -p[2], p[1]] } as unknown as Workplane;
    const box = new Float32Array([0, 0, 0, 3, 0, 0, 3, 0, -1, 0, 0, -1, 0, 3, 0, 3, 3, -1]);
    const [footprint] = ghostFootprints([{ expressId: 1, positions: box, normals: box, indices: new Uint32Array(), color: [0, 0, 0, 1] }], plane);
    const tidy = footprint.map((p) => p.map((v) => v + 0)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    assert.deepEqual(tidy, [[0, 0], [0, 1], [3, 0], [3, 1]]);
  });
});
