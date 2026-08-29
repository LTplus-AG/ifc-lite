/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { compareClashRuns } from './lifecycle.js';
import { runClash } from './engine-ts/orchestrator.js';
import { fromPositions } from './math/aabb.js';
import type { ClashKernel, NarrowRecord, RuleDetection } from './engine-ts/kernel.js';
import type {
  AABB,
  Clash,
  ClashElement,
  ClashResult,
  ClashRule,
  ClashSeverity,
  Vec3,
} from './types.js';

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

/**
 * Crosses the seam this suite otherwise never touches: `compareClashRuns`
 * (this file) is exercised ONLY against `makeClash` fixtures whose `id` is a
 * hand-typed literal ("c1", "shared", …) — never the id the real engine
 * (`engine-ts/orchestrator.ts`, its own well-covered `orchestrator.test.ts`)
 * actually computes. `orchestrator.ts`'s `clashId()` folds `ClashElement.model`
 * into the id (`${a.model} ${a.key}` / `${b.model} ${b.key}`), and `review.ts`
 * documents `model` as "an ephemeral per-load id in the viewer" — precisely
 * why `clashReviewKey` (review.ts) deliberately excludes it so a review
 * "re-attaches to the same clash after … a re-run" or "a model revision".
 * `compareClashRuns`'s own docstring claims the same durability ("not from
 * runtime refs that change between loads"), but its matching key is the raw
 * `clash.id` — which does carry `model`. Two model *loads* of the identical
 * geometry (the exact scenario `compareClashRuns` exists to diff) therefore
 * produce two different ids for the same real-world clash.
 */
describe('compareClashRuns × the real engine (engine-ts/orchestrator.ts)', () => {
  let nextRef = 1;
  function element(key: string, tag: string, model: string): ClashElement {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    return {
      key,
      ref: nextRef++,
      model,
      tag,
      bounds: fromPositions(positions),
      positions,
      indices: new Uint32Array([0, 1, 2]),
    };
  }
  const rec: NarrowRecord = {
    a: 0,
    b: 1,
    status: 'hard',
    distance: -0.1,
    distanceKind: 'mesh',
    point: [0, 0, 0] as Vec3,
    bounds: fromPositions(new Float32Array([0, 0, 0, 1, 1, 1])),
  };
  class OneShotKernel implements ClashKernel {
    prepare(): void {}
    detectRule(): RuleDetection {
      return { records: [rec], candidatesProcessed: 1, candidatesDropped: 0 };
    }
  }
  const rule: ClashRule = { id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct', mode: 'hard' };

  it('reports the SAME wall/duct clash as persistent across two model loads, not resolved+added', async () => {
    // "previous" and "next" are two independent loads of THE SAME two durably
    // -keyed elements — exactly what `compareClashRuns` is documented to diff
    // across ("Clash lifecycle across model revisions"). Only `model` differs,
    // as it would across two real loads.
    const previous = await runClash(
      [element('wall-1', 'IfcWall', 'load-1'), element('duct-1', 'IfcDuct', 'load-1')],
      [rule],
      {},
      new OneShotKernel(),
    );
    const next = await runClash(
      [element('wall-1', 'IfcWall', 'load-2'), element('duct-1', 'IfcDuct', 'load-2')],
      [rule],
      {},
      new OneShotKernel(),
    );

    expect(previous.clashes).toHaveLength(1);
    expect(next.clashes).toHaveLength(1);

    const diff = compareClashRuns(previous, next);

    expect(diff.persistent).toHaveLength(1);
    expect(diff.resolved).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
  });
});
