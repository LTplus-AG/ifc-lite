/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { compareClashRuns } from './lifecycle.js';
import type { AABB, Clash, ClashResult, ClashSeverity } from './types.js';

const BOUNDS: AABB = { min: [0, 0, 0], max: [1, 1, 1] };

function makeClash(id: string, severity: ClashSeverity = 'major'): Clash {
  return {
    id,
    a: { key: `${id}-a`, ref: 1, model: 'm', tag: 'IfcWall' },
    b: { key: `${id}-b`, ref: 2, model: 'm', tag: 'IfcDuctSegment' },
    rule: 'arch-vs-mep',
    status: 'hard',
    distance: -0.01,
    point: [0.5, 0.5, 0.5],
    bounds: BOUNDS,
    severity,
  };
}

function makeResult(clashes: Clash[]): ClashResult {
  return {
    clashes,
    summary: {
      total: clashes.length,
      byRule: {},
      byTypePair: {},
      bySeverity: { critical: 0, major: 0, minor: 0, info: 0 },
    },
    rulesRun: [],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

function ids(clashes: Clash[]): string[] {
  return clashes.map((c) => c.id);
}

describe('compareClashRuns', () => {
  it('partitions overlapping and non-overlapping ids', () => {
    // previous: c1, c2, c3 ; next: c2, c3, c4
    // -> resolved c1 ; persistent c2, c3 ; added c4
    const previous = makeResult([makeClash('c3'), makeClash('c1'), makeClash('c2')]);
    const next = makeResult([makeClash('c4'), makeClash('c2'), makeClash('c3')]);

    const diff = compareClashRuns(previous, next);

    expect(ids(diff.added)).toEqual(['c4']);
    expect(ids(diff.persistent)).toEqual(['c2', 'c3']);
    expect(ids(diff.resolved)).toEqual(['c1']);
    expect(diff.summary).toEqual({ added: 1, persistent: 2, resolved: 1 });
  });

  it('sorts each array deterministically by id', () => {
    const previous = makeResult([makeClash('b'), makeClash('a')]);
    const next = makeResult([makeClash('z'), makeClash('a'), makeClash('m')]);

    const diff = compareClashRuns(previous, next);

    expect(ids(diff.added)).toEqual(['m', 'z']);
    expect(ids(diff.persistent)).toEqual(['a']);
    expect(ids(diff.resolved)).toEqual(['b']);
  });

  it('persistent returns the next run Clash, not the previous one', () => {
    const prevClash = makeClash('shared', 'minor');
    prevClash.distance = -0.5;
    const nextClash = makeClash('shared', 'critical');
    nextClash.distance = -0.02;

    const diff = compareClashRuns(makeResult([prevClash]), makeResult([nextClash]));

    expect(diff.persistent).toHaveLength(1);
    expect(diff.persistent[0]).toBe(nextClash);
    expect(diff.persistent[0]?.severity).toBe('critical');
    expect(diff.persistent[0]?.distance).toBe(-0.02);
  });

  it('empty previous run: everything in next is added', () => {
    const next = makeResult([makeClash('y'), makeClash('x')]);

    const diff = compareClashRuns(makeResult([]), next);

    expect(ids(diff.added)).toEqual(['x', 'y']);
    expect(diff.persistent).toEqual([]);
    expect(diff.resolved).toEqual([]);
    expect(diff.summary).toEqual({ added: 2, persistent: 0, resolved: 0 });
  });

  it('empty next run: everything in previous is resolved', () => {
    const previous = makeResult([makeClash('q'), makeClash('p')]);

    const diff = compareClashRuns(previous, makeResult([]));

    expect(diff.added).toEqual([]);
    expect(diff.persistent).toEqual([]);
    expect(ids(diff.resolved)).toEqual(['p', 'q']);
    expect(diff.summary).toEqual({ added: 0, persistent: 0, resolved: 2 });
  });

  it('both runs empty: all buckets empty', () => {
    const diff = compareClashRuns(makeResult([]), makeResult([]));

    expect(diff.added).toEqual([]);
    expect(diff.persistent).toEqual([]);
    expect(diff.resolved).toEqual([]);
    expect(diff.summary).toEqual({ added: 0, persistent: 0, resolved: 0 });
  });

  it('is deterministic across repeated calls', () => {
    const previous = makeResult([makeClash('c2'), makeClash('c1')]);
    const next = makeResult([makeClash('c2'), makeClash('c3')]);

    const first = compareClashRuns(previous, next);
    const second = compareClashRuns(previous, next);

    expect(ids(first.added)).toEqual(ids(second.added));
    expect(ids(first.persistent)).toEqual(ids(second.persistent));
    expect(ids(first.resolved)).toEqual(ids(second.resolved));
    expect(first.summary).toEqual(second.summary);
  });
});
