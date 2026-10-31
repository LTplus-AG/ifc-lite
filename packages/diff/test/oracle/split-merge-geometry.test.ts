/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Box arithmetic and the two spatial structures the detector uses (issue
 * #1891). The grid and the clustering are accelerators, so the property under
 * test is that they answer a SUPERSET and never lose a real neighbour — a
 * dropped candidate is a claim that silently never happens.
 */

import { describe, expect, it } from 'vitest';
import {
  boxUnion,
  boxWithin,
  boxesTouch,
  buildBoxGrid,
  clusterByProximity,
  containmentPadding,
  extentCoverage,
  sortedExtents,
} from './split-merge-geometry.js';
import type { EntityAabb } from './types.js';

const box = (
  min: [number, number, number],
  max: [number, number, number],
): EntityAabb => ({ min, max });

describe('containmentPadding', () => {
  it('uses the ratio on a large box', () => {
    // Diagonal of a 3-4-12 box is 13; 1% of it beats the 50 mm floor.
    expect(containmentPadding(box([0, 0, 0], [3, 4, 12]), 0.05, 0.01)).toBeCloseTo(0.13, 10);
  });

  it('falls back to the floor on a small box', () => {
    // 1% of a 0.17 m diagonal is under 2 mm, which is less than a joint. The
    // floor is what carries small elements.
    expect(containmentPadding(box([0, 0, 0], [0.1, 0.1, 0.1]), 0.05, 0.01)).toBe(0.05);
  });
});

describe('boxWithin / boxesTouch', () => {
  const outer = box([0, 0, 0], [10, 10, 10]);

  it('accepts a box that pokes out by less than the padding', () => {
    expect(boxWithin(box([-0.04, 0, 0], [10, 10, 10]), outer, 0.05)).toBe(true);
  });

  it('rejects a box that pokes out by more', () => {
    expect(boxWithin(box([0, 0, 0], [10, 10, 10.06]), outer, 0.05)).toBe(false);
  });

  it('is per-axis: escaping on one axis is enough to reject', () => {
    expect(boxWithin(box([0, -1, 0], [10, 10, 10]), outer, 0.05)).toBe(false);
  });

  it('treats a shared face as touching', () => {
    expect(boxesTouch(box([0, 0, 0], [1, 1, 1]), box([1, 0, 0], [2, 1, 1]), 0)).toBe(true);
  });

  it('joins two boxes across a gap the padding covers, and not one it does not', () => {
    const a = box([0, 0, 0], [1, 1, 1]);
    expect(boxesTouch(a, box([1.09, 0, 0], [2, 1, 1]), 0.05)).toBe(true);
    expect(boxesTouch(a, box([1.11, 0, 0], [2, 1, 1]), 0.05)).toBe(false);
  });
});

describe('sortedExtents / boxUnion', () => {
  it('sorts the extents so a 90° turn is invisible', () => {
    // The property the displaced lane depends on: turning the element permutes
    // the axis-aligned extents, and the multiset survives the permutation.
    expect(sortedExtents(box([0, 0, 0], [6, 0.2, 3]))).toEqual([0.2, 3, 6]);
    expect(sortedExtents(box([0, 0, 0], [0.2, 6, 3]))).toEqual([0.2, 3, 6]);
  });

  it('takes the min of every min and the max of every max', () => {
    expect(boxUnion([box([0, 5, 0], [1, 6, 1]), box([-2, 0, 3], [0, 1, 4])])).toEqual(
      box([-2, 0, 0], [1, 6, 4]),
    );
  });
});

describe('extentCoverage', () => {
  const whole = box([0, 0, 0], [6, 0.2, 3]);
  const tile = (from: number, to: number): EntityAabb => box([from, 0, 0], [to, 0.2, 3]);

  it('accepts three tiles that meet', () => {
    expect(extentCoverage(whole, [tile(0, 2), tile(2, 4), tile(4, 6)], 0.05)).toBe(true);
  });

  it('accepts joints no wider than the padding', () => {
    expect(extentCoverage(whole, [tile(0, 2), tile(2.04, 4), tile(4.04, 6)], 0.05)).toBe(true);
  });

  it('rejects a gap in the middle', () => {
    expect(extentCoverage(whole, [tile(0, 2), tile(4, 6)], 0.05)).toBe(false);
  });

  it('rejects a short run that stops before the end', () => {
    expect(extentCoverage(whole, [tile(0, 2), tile(2, 4)], 0.05)).toBe(false);
  });

  it('rejects a run that starts late', () => {
    expect(extentCoverage(whole, [tile(0.5, 3), tile(3, 6)], 0.05)).toBe(false);
  });

  it('is order-independent — it sorts the intervals itself', () => {
    expect(extentCoverage(whole, [tile(4, 6), tile(0, 2), tile(2, 4)], 0.05)).toBe(true);
  });

  it('accepts overlapping pieces, and never sums their volumes', () => {
    // #1993 measured 66% of multi-segment elements with overlapping boxes, so a
    // coverage test that punished overlap would abstain on most of the model —
    // and one that SUMMED box volumes would report nonsense on it.
    expect(extentCoverage(whole, [tile(0, 4), tile(2, 6)], 0.05)).toBe(true);
  });

  it('checks all three axes, not just the long one', () => {
    // Tiles that span the wall end to end but only reach a third of its height:
    // axis 0 is covered perfectly and axis 2 is not, so an implementation that
    // stopped after the first axis would call this a split.
    const short = (from: number, to: number): EntityAabb => box([from, 0, 0], [to, 0.2, 1]);
    expect(extentCoverage(whole, [short(0, 2), short(2, 4), short(4, 6)], 0.05)).toBe(false);
  });

  it('refuses an empty set rather than vacuously covering', () => {
    expect(extentCoverage(whole, [], 0.05)).toBe(false);
  });
});

describe('buildBoxGrid', () => {
  it('answers a superset that contains every real overlap', () => {
    const boxes = [
      box([0, 0, 0], [1, 1, 1]),
      box([10, 0, 0], [11, 1, 1]),
      box([0.5, 0, 0], [1.5, 1, 1]),
    ];
    const grid = buildBoxGrid(boxes);
    const hits = grid.query(box([0, 0, 0], [1, 1, 1]), 0);
    expect(hits).toContain(0);
    expect(hits).toContain(2);
    expect(hits).not.toContain(1);
  });

  it('finds a neighbour only the padding reaches', () => {
    const grid = buildBoxGrid([box([1.02, 0, 0], [2, 1, 1])]);
    expect(grid.query(box([0, 0, 0], [1, 1, 1]), 0.05)).toEqual([0]);
  });

  it('still finds everything when the query is huge and falls back to a scan', () => {
    // The MAX_QUERY_CELLS escape hatch is a performance branch, not a
    // correctness one: both branches must return the same candidates.
    const boxes = [box([0, 0, 0], [1, 1, 1]), box([500, 500, 500], [501, 501, 501])];
    const grid = buildBoxGrid(boxes);
    expect(grid.query(box([-1000, -1000, -1000], [1000, 1000, 1000]), 0)).toEqual([0, 1]);
  });

  it('indexes degenerate point boxes instead of dividing by zero', () => {
    const grid = buildBoxGrid([box([0, 0, 0], [0, 0, 0]), box([0, 0, 0], [0, 0, 0])]);
    expect(grid.query(box([0, 0, 0], [0, 0, 0]), 0)).toEqual([0, 1]);
  });

  it('is empty, not broken, with nothing indexed', () => {
    expect(buildBoxGrid([]).query(box([0, 0, 0], [1, 1, 1]), 1)).toEqual([]);
  });
});

describe('clusterByProximity', () => {
  const pad = (boxes: EntityAabb[], value: number): number[] => boxes.map(() => value);

  it('joins a chain transitively', () => {
    // A and C never touch; B is what makes them one cluster. A pairwise test
    // without the union-find would report three.
    const boxes = [
      box([0, 0, 0], [1, 1, 1]),
      box([1, 0, 0], [2, 1, 1]),
      box([2, 0, 0], [3, 1, 1]),
    ];
    expect(clusterByProximity(boxes, pad(boxes, 0.01))).toEqual([[0, 1, 2]]);
  });

  it('keeps separated groups apart', () => {
    const boxes = [
      box([0, 0, 0], [1, 1, 1]),
      box([1, 0, 0], [2, 1, 1]),
      box([50, 0, 0], [51, 1, 1]),
    ];
    expect(clusterByProximity(boxes, pad(boxes, 0.01))).toEqual([[0, 1], [2]]);
  });

  it('uses each box’s OWN padding, taking the larger of the two', () => {
    // A 50 mm bolt and a 6 m panel cannot share one threshold and still mean
    // the same thing, so the rule is per box.
    const boxes = [box([0, 0, 0], [1, 1, 1]), box([1.4, 0, 0], [2, 1, 1])];
    expect(clusterByProximity(boxes, [0.01, 0.01])).toEqual([[0], [1]]);
    expect(clusterByProximity(boxes, [0.01, 0.25])).toEqual([[0, 1]]);
  });

  it('joins a pair across a cell boundary the query would otherwise stop at', () => {
    // The candidate generator has to reach at least as far as the predicate it
    // feeds. `boxesTouch` grows BOTH boxes, so it accepts this 80 mm gap on 50 mm
    // paddings; a query expanded by one padding width reaches only 50 mm.
    //
    // The cell size is the largest box's longest side, 1.0 here, so the boundary
    // at x = 1.0 lies inside the gap: box 0 occupies cell 0 alone and box 1
    // cells 1..2, and the reverse query that would have found the pair is
    // dropped by `j <= i`. A narrower query therefore reports TWO clusters —
    // and would report one if the same two boxes sat 0.2 m further left.
    const boxes = [box([0, 0, 0], [0.94, 1, 1]), box([1.02, 0, 0], [2.02, 1, 1])];
    expect(boxesTouch(boxes[0], boxes[1], 0.05)).toBe(true);
    expect(clusterByProximity(boxes, [0.05, 0.05])).toEqual([[0, 1]]);
  });

  it('is deterministic and ascending, whatever order the boxes arrive in', () => {
    const boxes = [
      box([50, 0, 0], [51, 1, 1]),
      box([1, 0, 0], [2, 1, 1]),
      box([0, 0, 0], [1, 1, 1]),
    ];
    expect(clusterByProximity(boxes, pad(boxes, 0.01))).toEqual([[0], [1, 2]]);
  });
});
