/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `line-merger.ts` had no test file. `mergeDrawingLines` runs on every
 * generated drawing (`drawing-generator.ts`), and `mergeCollinearLines`,
 * `deduplicateLines` and `splitLineAtParams` are all published from the
 * package barrel with no in-repo caller at all — definition plus re-export
 * were their only two occurrences in the repository.
 *
 * The failure mode is quiet: a merge that is too eager fuses lines that
 * belong to different categories (a cut line swallowing a hidden line
 * changes its weight and dash pattern), and one that is too timid leaves
 * the SVG/DXF full of hairline seams. Neither throws.
 */

import { describe, expect, it } from 'vitest';
import {
  deduplicateLines,
  mergeCollinearLines,
  mergeDrawingLines,
  splitLineAtParams,
} from './line-merger.js';
import type { DrawingLine, Line2D } from './types.js';

const seg = (x0: number, y0: number, x1: number, y1: number): Line2D => ({
  start: { x: x0, y: y0 },
  end: { x: x1, y: y1 },
});

const drawingLine = (line: Line2D, over: Partial<DrawingLine> = {}): DrawingLine => ({
  line,
  category: 'cut',
  visibility: 'visible',
  entityId: 1,
  ifcType: 'IfcWall',
  modelIndex: 0,
  depth: 0,
  ...over,
});

const lengthOf = (l: Line2D) =>
  Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y);

describe('mergeCollinearLines', () => {
  it('fuses two touching collinear segments into one', () => {
    const merged = mergeCollinearLines([seg(0, 0, 1, 0), seg(1, 0, 2, 0)]);
    expect(merged).toHaveLength(1);
    expect(lengthOf(merged[0])).toBeCloseTo(2, 9);
  });

  it('fuses overlapping segments without double-counting the overlap', () => {
    const merged = mergeCollinearLines([seg(0, 0, 3, 0), seg(1, 0, 2, 0)]);
    expect(merged).toHaveLength(1);
    expect(lengthOf(merged[0])).toBeCloseTo(3, 9);
  });

  it('keeps parallel segments on DIFFERENT lines apart', () => {
    // Same direction, offset by 1 in Y — far beyond distanceTolerance.
    const merged = mergeCollinearLines([seg(0, 0, 1, 0), seg(0, 1, 1, 1)]);
    expect(merged).toHaveLength(2);
  });

  // A truly parallel offset segment is rejected TWICE over — its start and
  // its end are both off the reference line — so either half of the
  // same-line test alone satisfies the case above: deleting the start-point
  // check and replacing the end-point check with `return true` each survive
  // it (measured, round-four self-audit). The two fixtures below are
  // slightly convergent instead: both sit inside the same angle bucket
  // (bucketSize = 2 * angleTolerance = 0.02 rad) as the tilted reference
  // line, and each is on the wrong side of exactly ONE of the two checks.
  // Fusing either would weld a nearly-parallel neighbour onto the reference
  // line and lengthen it.
  it('rejects a near-parallel segment whose START lies on the reference line', () => {
    const reference = seg(0, 0, 10, 0.1); // angle 0.01 rad
    // Start offset 0.0005 (inside distanceTolerance 0.001), end offset 0.0995.
    const converging = seg(0, 0.0005, 10, 0.0005);
    expect(mergeCollinearLines([reference, converging])).toHaveLength(2);
  });

  it('rejects a near-parallel segment whose END lies on the reference line', () => {
    const reference = seg(0, 0, 10, 0.1);
    // Mirror image: start offset 0.0995, end offset 0.0005.
    const converging = seg(0, 0.0995, 10, 0.0995);
    expect(mergeCollinearLines([reference, converging])).toHaveLength(2);
  });

  it('keeps segments of different direction apart', () => {
    const merged = mergeCollinearLines([seg(0, 0, 1, 0), seg(0, 0, 0, 1)]);
    expect(merged).toHaveLength(2);
  });

  it('returns single-element and empty inputs unchanged', () => {
    expect(mergeCollinearLines([])).toEqual([]);
    const one = [seg(0, 0, 1, 0)];
    expect(mergeCollinearLines(one)).toEqual(one);
  });

  describe('gapTolerance', () => {
    // A collinear gap SMALLER than gapTolerance is bridged; a larger one is
    // not. Both sides are needed: with the tolerance term deleted the first
    // case silently produces two hairline segments instead of one line.
    it('bridges a gap strictly inside the tolerance', () => {
      const merged = mergeCollinearLines(
        [seg(0, 0, 1, 0), seg(1.005, 0, 2, 0)],
        { gapTolerance: 0.01 },
      );
      expect(merged).toHaveLength(1);
      expect(lengthOf(merged[0])).toBeCloseTo(2, 9);
    });

    it('does NOT bridge a gap outside the tolerance', () => {
      const merged = mergeCollinearLines(
        [seg(0, 0, 1, 0), seg(1.005, 0, 2, 0)],
        { gapTolerance: 0.001 },
      );
      expect(merged).toHaveLength(2);
    });

    it('applies the DEFAULT gapTolerance when options are omitted entirely', () => {
      // The default (0.01) is what production passes: `drawing-generator`
      // calls `mergeDrawingLines(allLines)` with no options object, so the
      // absent-argument path is the one that ships.
      const bridged = mergeCollinearLines([seg(0, 0, 1, 0), seg(1.005, 0, 2, 0)]);
      expect(bridged).toHaveLength(1);
      const notBridged = mergeCollinearLines([seg(0, 0, 1, 0), seg(1.5, 0, 2, 0)]);
      expect(notBridged).toHaveLength(2);
    });
  });
});

describe('mergeDrawingLines grouping', () => {
  const a = seg(0, 0, 1, 0);
  const b = seg(1, 0, 2, 0);

  it('merges collinear lines that share entity, category and visibility', () => {
    const merged = mergeDrawingLines([drawingLine(a), drawingLine(b)]);
    expect(merged).toHaveLength(1);
    expect(lengthOf(merged[0].line)).toBeCloseTo(2, 9);
  });

  it('does NOT merge across line categories', () => {
    // A cut line and a projection line render at different weights; fusing
    // them would relabel one of them.
    const merged = mergeDrawingLines([
      drawingLine(a, { category: 'cut' }),
      drawingLine(b, { category: 'projection' }),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((l) => l.category).sort()).toEqual(['cut', 'projection']);
  });

  it('does NOT merge across visibility states', () => {
    // Hidden lines are dashed; merging a hidden run into a visible one
    // would draw the occluded part solid.
    const merged = mergeDrawingLines([
      drawingLine(a, { visibility: 'visible' }),
      drawingLine(b, { visibility: 'hidden' }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('does NOT merge across entities', () => {
    const merged = mergeDrawingLines([
      drawingLine(a, { entityId: 1 }),
      drawingLine(b, { entityId: 2 }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('does NOT merge across federated models', () => {
    const merged = mergeDrawingLines([
      drawingLine(a, { modelIndex: 0 }),
      drawingLine(b, { modelIndex: 1 }),
    ]);
    expect(merged).toHaveLength(2);
  });

  // #2639 made per-endpoint view depth meaningful (`depth` at start,
  // `depthEnd` at end). A merged line must report the depths of the SOURCE
  // endpoints that became its endpoints — copying the first segment's pair
  // onto the whole merged run was only lossless while every projection line
  // carried depth 0.
  it('derives merged endpoint depths from the contributing source segments', () => {
    const merged = mergeDrawingLines([
      drawingLine(a, { depth: 1, depthEnd: 2 }),
      drawingLine(b, { depth: 2, depthEnd: 3 }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].depth).toBeCloseTo(1, 9);
    expect(merged[0].depthEnd).toBeCloseTo(3, 9);
    // Non-depth properties still come from the group.
    expect(merged[0].entityId).toBe(1);
    expect(merged[0].ifcType).toBe('IfcWall');
    expect(merged[0].category).toBe('cut');
  });

  it('swaps depths for a source segment that runs against the merge direction', () => {
    // The first line runs right-to-left, so the merged line runs in -x from
    // (2,0) to (0,0). The second segment runs left-to-right — against the
    // merge direction — so its START point (0,0) becomes the merged END, and
    // the merged `depthEnd` must be that point's depth (3), not the
    // segment's own `depthEnd` (4).
    const merged = mergeDrawingLines([
      drawingLine(seg(2, 0, 1, 0), { depth: 5, depthEnd: 4 }),
      drawingLine(seg(0, 0, 1, 0), { depth: 3, depthEnd: 4 }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].line.start.x).toBeCloseTo(2, 9);
    expect(merged[0].line.end.x).toBeCloseTo(0, 9);
    expect(merged[0].depth).toBeCloseTo(5, 9);
    expect(merged[0].depthEnd).toBeCloseTo(3, 9);
  });

  it('omits depthEnd when both merged endpoints land on the same depth', () => {
    // Interior depths differ, but the merged endpoints (0,0) and (2,0) both
    // sit at depth 2 — the contract says "omitted means constant depth", so
    // a stale template depthEnd must not leak through.
    const merged = mergeDrawingLines([
      drawingLine(a, { depth: 2, depthEnd: 1 }),
      drawingLine(b, { depth: 1, depthEnd: 2 }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].depth).toBeCloseTo(2, 9);
    expect(merged[0].depthEnd).toBeUndefined();
  });

  it('treats a missing source depthEnd as the constant source depth', () => {
    // The constant-depth segment comes FIRST so it is the property template;
    // the merged depths must still be read off the source endpoints.
    const merged = mergeDrawingLines([
      drawingLine(b, { depth: 2 }), // constant depth 2 along the segment
      drawingLine(a, { depth: 1, depthEnd: 2 }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].line.start.x).toBeCloseTo(0, 9);
    expect(merged[0].line.end.x).toBeCloseTo(2, 9);
    expect(merged[0].depth).toBeCloseTo(1, 9);
    expect(merged[0].depthEnd).toBeCloseTo(2, 9);
  });

  it('carries the group metadata onto the merged line', () => {
    const merged = mergeDrawingLines([
      drawingLine(a, { entityId: 42, ifcType: 'IfcSlab', category: 'hidden' }),
      drawingLine(b, { entityId: 42, ifcType: 'IfcSlab', category: 'hidden' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].entityId).toBe(42);
    expect(merged[0].ifcType).toBe('IfcSlab');
    expect(merged[0].category).toBe('hidden');
  });
});

describe('deduplicateLines', () => {
  it('drops an exact duplicate', () => {
    expect(deduplicateLines([seg(0, 0, 1, 1), seg(0, 0, 1, 1)])).toHaveLength(1);
  });

  // Section cutting emits the shared edge of two adjacent faces twice, once
  // from each face and in opposite order. Without the reverse-direction
  // match every such edge is drawn twice.
  it('drops a duplicate written in the OPPOSITE direction', () => {
    const kept = deduplicateLines([seg(0, 0, 1, 1), seg(1, 1, 0, 0)]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toEqual(seg(0, 0, 1, 1)); // first occurrence wins
  });

  it('keeps genuinely distinct lines', () => {
    expect(deduplicateLines([seg(0, 0, 1, 1), seg(0, 0, 1, 2)])).toHaveLength(2);
  });

  it('honours the tolerance in both directions', () => {
    const near = [seg(0, 0, 1, 1), seg(1.0005, 1.0005, 0, 0)];
    expect(deduplicateLines(near, 0.01)).toHaveLength(1);
    expect(deduplicateLines(near, 0.0001)).toHaveLength(2);
  });

  it('returns an empty array for empty input', () => {
    expect(deduplicateLines([])).toEqual([]);
  });
});

describe('splitLineAtParams', () => {
  const line = seg(0, 0, 10, 0);

  it('returns the whole line when there is nothing to split at', () => {
    const parts = splitLineAtParams(line, []);
    expect(parts).toHaveLength(1);
    expect(parts[0].start).toEqual({ x: 0, y: 0 });
    expect(parts[0].end).toEqual({ x: 10, y: 0 });
  });

  it('splits at an interior parameter and covers the line exactly', () => {
    const parts = splitLineAtParams(line, [0.25]);
    expect(parts).toHaveLength(2);
    expect(parts[0].end.x).toBeCloseTo(2.5, 9);
    expect(parts[1].start.x).toBeCloseTo(2.5, 9);
    expect(parts.reduce((s, p) => s + lengthOf(p), 0)).toBeCloseTo(10, 9);
  });

  it('sorts unordered parameters', () => {
    const parts = splitLineAtParams(line, [0.75, 0.25]);
    expect(parts.map((p) => p.start.x)).toEqual([0, 2.5, 7.5]);
  });

  // Hidden-line removal feeds raw intersection parameters in here; those can
  // fall outside [0, 1] when the occluder extends past the segment. Keeping
  // them would emit segments that run off the end of the line.
  it('discards parameters outside the open interval (0, 1)', () => {
    const parts = splitLineAtParams(line, [-0.5, 0.5, 1.5]);
    expect(parts).toHaveLength(2);
    expect(parts[0].start.x).toBeCloseTo(0, 9);
    expect(parts[parts.length - 1].end.x).toBeCloseTo(10, 9);
    for (const p of parts) {
      for (const x of [p.start.x, p.end.x]) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(10);
      }
    }
  });

  it('never emits a zero-length segment for a duplicated or endpoint parameter', () => {
    for (const params of [[0.5, 0.5], [0], [1], [0, 1]]) {
      for (const p of splitLineAtParams(line, params)) {
        expect(lengthOf(p)).toBeGreaterThan(0);
      }
    }
  });
});
