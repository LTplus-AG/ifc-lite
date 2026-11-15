/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { curvePoints } from '../src/model/outline.js';
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

  it('takes an arc segment through its stored points', () => {
    expect(curvePoints(curve([['IFCLINEINDEX', [1, 2]], ['IFCARCINDEX', [2, 3, 5]]]), 1)).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
  });

  it('an out-of-range or malformed segment makes the outline unreadable, never a guess', () => {
    expect(curvePoints(curve([['IFCLINEINDEX', [1, 9]]]), 1)).toBeNull();
    expect(curvePoints(curve([['IFCLINEINDEX', [0, 1]]]), 1)).toBeNull();
    expect(curvePoints(curve([[1, 2, 3]]), 1)).toBeNull();
    expect(curvePoints(curve([]), 1)).toBeNull();
  });
});
