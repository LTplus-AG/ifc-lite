/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { compareClashRuns } from './lifecycle.js';
import { clashReviewKey } from './review.js';
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
  function record(a: number, b: number): NarrowRecord {
    return {
      a,
      b,
      status: 'hard',
      distance: -0.1,
      distanceKind: 'mesh',
      point: [0, 0, 0] as Vec3,
      bounds: fromPositions(new Float32Array([0, 0, 0, 1, 1, 1])),
    };
  }
  /** Feeds the orchestrator a fixed narrow-phase result, so the test controls
   *  exactly which element pairs become clashes. */
  class FixedKernel implements ClashKernel {
    constructor(private readonly records: NarrowRecord[]) {}
    prepare(): void {}
    detectRule(): RuleDetection {
      return {
        records: this.records,
        candidatesProcessed: this.records.length,
        candidatesDropped: 0,
      };
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
      new FixedKernel([record(0, 1)]),
    );
    const next = await runClash(
      [element('wall-1', 'IfcWall', 'load-2'), element('duct-1', 'IfcDuct', 'load-2')],
      [rule],
      {},
      new FixedKernel([record(0, 1)]),
    );

    expect(previous.clashes).toHaveLength(1);
    expect(next.clashes).toHaveLength(1);

    const diff = compareClashRuns(previous, next);

    expect(diff.persistent).toHaveLength(1);
    expect(diff.resolved).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
  });

  /**
   * The other half of the same seam. `clashReviewKey` drops `ClashElement.
   * model` — that is what makes it durable — but the engine treats
   * `(model, key)` as element identity (`orchestrator.ts` skips a pair only
   * when key AND model match), and `adapters/ifcx.ts` sets `key` to the bare
   * USD prim path while a federated run gathers every loaded model. So one
   * run legitimately holds two DISTINCT clashes under one review key: the
   * wall against `/Duct` in layer-a, and the wall against `/Duct` in layer-b.
   * `model` is held STABLE across both runs here, so nothing about the
   * cross-load fix is in play — only whether multiplicity survives.
   *
   * Every assertion below is on the clash IDS, not just `diff.summary`: with
   * counts alone, a diff that puts the right number of entries in the wrong
   * buckets passes.
   */
  const wallA = () => element('/Wall', 'IfcWall', 'layer-a');
  const ductA = () => element('/Duct', 'IfcDuct', 'layer-a');
  const ductB = () => element('/Duct', 'IfcDuct', 'layer-b');
  const CLASH_A = 'r layer-a /Duct layer-a /Wall';
  const CLASH_B = 'r layer-a /Wall layer-b /Duct';

  it('one federated run holds two distinct clashes under a single review key', async () => {
    const run = await runClash(
      [wallA(), ductA(), ductB()],
      [rule],
      {},
      new FixedKernel([record(0, 1), record(0, 2)]),
    );

    expect(ids(run.clashes).sort()).toEqual([CLASH_A, CLASH_B]);
    expect(new Set(run.clashes.map(clashReviewKey)).size).toBe(1);
  });

  it('a second clash under an already-present review key is added, not swallowed', async () => {
    const previous = await runClash([wallA(), ductA()], [rule], {}, new FixedKernel([record(0, 1)]));
    const next = await runClash(
      [wallA(), ductA(), ductB()],
      [rule],
      {},
      new FixedKernel([record(0, 1), record(0, 2)]),
    );

    const diff = compareClashRuns(previous, next);

    expect(ids(diff.added)).toEqual([CLASH_B]);
    expect(ids(diff.persistent)).toEqual([CLASH_A]);
    expect(ids(diff.resolved)).toEqual([]);
  });

  /**
   * The case the positional leftover pairing gets wrong if it is not told to
   * look at `model`. Both runs load the SAME three elements under the SAME
   * model ids — no reload happened — and the two clashes share one review key,
   * so the counts are equal (1 vs 1) and the ids do not match. Pairing on
   * count alone calls the new clash `persistent` and drops the fixed one out
   * of `resolved` entirely: the coordinator is told a clash they just fixed is
   * still open and never hears about the one that appeared.
   */
  it('a same-session layer swap under one review key is added + resolved, not persistent', async () => {
    const previous = await runClash(
      [wallA(), ductA(), ductB()],
      [rule],
      {},
      new FixedKernel([record(0, 1)]),
    );
    const next = await runClash(
      [wallA(), ductA(), ductB()],
      [rule],
      {},
      new FixedKernel([record(0, 2)]),
    );

    expect(ids(previous.clashes)).toEqual([CLASH_A]);
    expect(ids(next.clashes)).toEqual([CLASH_B]);

    const diff = compareClashRuns(previous, next);

    expect(ids(diff.added)).toEqual([CLASH_B]);
    expect(ids(diff.persistent)).toEqual([]);
    expect(ids(diff.resolved)).toEqual([CLASH_A]);
  });

  /**
   * The other direction of the same model test: layer-b IS re-loaded (new
   * `model` id) while layer-a is not, so one clash id-matches and the other
   * does not. The leftovers must still pair into `persistent` — a fix that
   * sent every non-id-matching leftover straight to `added` + `resolved` would
   * re-open the very churn this module exists to remove.
   */
  it('a leftover whose model was re-minted still pairs into persistent', async () => {
    const previous = await runClash(
      [wallA(), ductA(), ductB()],
      [rule],
      {},
      new FixedKernel([record(0, 1), record(0, 2)]),
    );
    const next = await runClash(
      [wallA(), ductA(), element('/Duct', 'IfcDuct', 'layer-b2')],
      [rule],
      {},
      new FixedKernel([record(0, 1), record(0, 2)]),
    );

    const diff = compareClashRuns(previous, next);

    expect(ids(diff.added)).toEqual([]);
    expect(ids(diff.persistent)).toEqual([CLASH_A, 'r layer-a /Wall layer-b2 /Duct']);
    expect(ids(diff.resolved)).toEqual([]);
  });

  it('one of two clashes under a shared review key going away is resolved, not lost', async () => {
    const previous = await runClash(
      [wallA(), ductA(), ductB()],
      [rule],
      {},
      new FixedKernel([record(0, 1), record(0, 2)]),
    );
    const next = await runClash([wallA(), ductB()], [rule], {}, new FixedKernel([record(0, 1)]));

    const diff = compareClashRuns(previous, next);

    expect(ids(diff.added)).toEqual([]);
    expect(ids(diff.persistent)).toEqual([CLASH_B]);
    expect(ids(diff.resolved)).toEqual([CLASH_A]);
  });
});
