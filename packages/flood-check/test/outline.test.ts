/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { ARC_SAGITTA, curvePoints } from '../src/model/outline.js';
import type { ModelReader } from '../src/model/reader.js';

/** A reader over hand-written decoded entities (typed values decode to [TYPE, value]). */
function readerOf(entities: Record<number, { type: string; attributes: unknown[] }>): ModelReader {
  return { entity: (id: number | null) => (id === null ? null : entities[id] ?? null) } as unknown as ModelReader;
}

const list = { type: 'IFCCARTESIANPOINTLIST2D', attributes: [[[0, 0], [10, 0], [10, 10], [99, 99], [0, 10]], null] };
const curve = (segments: unknown) => readerOf({ 1: { type: 'IFCINDEXEDPOLYCURVE', attributes: [2, segments, null] }, 2: list });

describe('IfcIndexedPolyCurve outline', () => {
  it('without Segments the points are read in list order', () => {
    expect(curvePoints(curve(null), 1)).toEqual([[0, 0], [10, 0], [10, 10], [99, 99], [0, 10]]);
  });

  it('follows Segments: the order they trace, and an unused point is left out', () => {
    // Points 1,2,3,5 traced and closed; point 4 (99, 99) is on no segment.
    const segments = [['IFCLINEINDEX', [1, 2, 3]], ['IFCLINEINDEX', [3, 5, 1]]];
    expect(curvePoints(curve(segments), 1)).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
  });

  it('an arc segment keeps its circle\'s axis-aligned extremes, in order, and every point it adds lies on the circle or just outside it (audit finding 9)', () => {
    // The arc through (10, 0), (10, 10), (0, 10): centre (5, 5), radius 5√2; its rightmost (east) and topmost (north) points lie on it.
    // Since the CodeRabbit review it is also traced between them (review-geometry.test.ts), so the list is longer than these.
    const r = 5 * Math.SQRT2;
    const pts = curvePoints(curve([['IFCLINEINDEX', [1, 2]], ['IFCARCINDEX', [2, 3, 5]]]), 1)!;
    const want = [[0, 0], [10, 0], [5 + r, 5], [10, 10], [5, 5 + r], [0, 10]];
    let from = 0;
    for (const [x, y] of want) {
      const i = pts.findIndex((p, k) => k >= from && Math.abs(p[0] - x) < 1e-9 && Math.abs(p[1] - y) < 1e-9);
      expect(i, `${x},${y}`).toBeGreaterThanOrEqual(from);
      from = i + 1;
    }
    for (const [x, y] of pts.slice(2)) {
      const off = Math.hypot(x - 5, y - 5) - r;
      expect(off).toBeGreaterThanOrEqual(-1e-9);
      expect(off).toBeLessThanOrEqual(ARC_SAGITTA * r + 1e-9);
    }
  });

  it('an out-of-range or malformed segment makes the outline unreadable, never a guess', () => {
    expect(curvePoints(curve([['IFCLINEINDEX', [1, 9]]]), 1)).toBeNull();
    expect(curvePoints(curve([['IFCLINEINDEX', [0, 1]]]), 1)).toBeNull();
    expect(curvePoints(curve([[1, 2, 3]]), 1)).toBeNull();
    expect(curvePoints(curve([]), 1)).toBeNull();
  });
});
