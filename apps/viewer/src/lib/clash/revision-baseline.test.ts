/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { Clash, ClashResult, ClashRuleCoverage } from '@ifc-lite/clash';
import { captureModelNames, loadRevisionBaseline, saveRevisionBaseline } from './revision-baseline.js';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
}

/** Mirrors a real browser `localStorage`: `setItem` throws once the total
 *  stored size would exceed `limit` (bytes, UTF-16 code units) — same
 *  contract as `QuotaExceededError`, just without a DOM to get it from. */
class QuotaLimitedStorage {
  private store = new Map<string, string>();
  constructor(private readonly limit: number) {}
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void {
    const existing = this.store.get(key)?.length ?? 0;
    const projected = [...this.store.entries()].reduce((sum, [k, v]) => sum + (k === key ? 0 : v.length), 0)
      + value.length;
    if (projected > this.limit) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    void existing;
    this.store.set(key, value);
  }
  removeItem(key: string): void { this.store.delete(key); }
}

const g = globalThis as { localStorage?: unknown };

function clash(model: string): Clash {
  return {
    id: 'r m1 m2',
    a: { key: 'a', ref: 1, model, tag: 'IfcWall' },
    b: { key: 'b', ref: 2, model, tag: 'IfcDuct' },
    rule: 'r',
    status: 'hard',
    distance: -0.01,
    point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    severity: 'major',
  };
}

function result(clashes: Clash[]): ClashResult {
  return {
    clashes,
    summary: { total: clashes.length, byRule: {}, byTypePair: {}, bySeverity: { critical: 0, major: 0, minor: 0, info: 0 } },
    rulesRun: [],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

describe('clash revision baseline persistence (#3928)', () => {
  beforeEach(() => {
    g.localStorage = new MemoryStorage();
  });

  it('returns null when nothing is stored', () => {
    assert.strictEqual(loadRevisionBaseline(), null);
  });

  it('round-trips a saved baseline (result + model names + timestamp)', () => {
    const r = result([clash('m1')]);
    const save = saveRevisionBaseline({ result: r, modelNames: { m1: 'building.ifc' }, takenAt: 1000 });
    assert.deepStrictEqual(save, { ok: true });

    const loaded = loadRevisionBaseline();
    assert.ok(loaded);
    assert.strictEqual(loaded.takenAt, 1000);
    assert.deepStrictEqual(loaded.modelNames, { m1: 'building.ifc' });
    assert.strictEqual(loaded.result.clashes.length, 1);
    assert.strictEqual(loaded.result.clashes[0]?.id, 'r m1 m2');
  });

  it('clearing with null removes the stored baseline', () => {
    saveRevisionBaseline({ result: result([]), modelNames: {}, takenAt: 1 });
    assert.notStrictEqual(loadRevisionBaseline(), null);

    assert.deepStrictEqual(saveRevisionBaseline(null), { ok: true });
    assert.strictEqual(loadRevisionBaseline(), null);
  });

  it('a corrupted stored value is treated as absent, not thrown', () => {
    (g.localStorage as MemoryStorage).setItem('ifc-lite-clash-revision-baseline', '{not json');
    const previousWarn = console.warn;
    let reported = false;
    console.warn = () => { reported = true; };
    try {
      assert.strictEqual(loadRevisionBaseline(), null);
    } finally {
      console.warn = previousWarn;
    }
    assert.strictEqual(reported, true);
  });

  it('a structurally-thin baseline (result missing clashes) is rejected, not accepted as valid (#3947)', () => {
    // `body.result` here IS a plain object, so a check that only asks
    // `typeof result === 'object'` accepts it — then `compareClashRuns`'s
    // `for (const clash of run.clashes)` throws on `undefined`, uncaught, in
    // the compare dialog's click handler.
    (g.localStorage as MemoryStorage).setItem(
      'ifc-lite-clash-revision-baseline',
      JSON.stringify({ schemaVersion: 1, baseline: { result: {}, modelNames: {}, takenAt: 1 } }),
    );
    assert.strictEqual(loadRevisionBaseline(), null);
  });

  it('a baseline whose result.clashes is present but not an array is rejected', () => {
    (g.localStorage as MemoryStorage).setItem(
      'ifc-lite-clash-revision-baseline',
      JSON.stringify({ schemaVersion: 1, baseline: { result: { clashes: 'nope' }, modelNames: {}, takenAt: 1 } }),
    );
    assert.strictEqual(loadRevisionBaseline(), null);
  });

  it('a baseline stored under an unrecognized schema version is rejected, not trusted as-is (#3947)', () => {
    const validBody = { result: result([clash('m1')]), modelNames: { m1: 'building.ifc' }, takenAt: 1000 };
    (g.localStorage as MemoryStorage).setItem(
      'ifc-lite-clash-revision-baseline',
      JSON.stringify({ schemaVersion: 999, baseline: validBody }),
    );
    assert.strictEqual(loadRevisionBaseline(), null);
  });

  it('a baseline with no schemaVersion at all is rejected', () => {
    const validBody = { result: result([clash('m1')]), modelNames: { m1: 'building.ifc' }, takenAt: 1000 };
    (g.localStorage as MemoryStorage).setItem('ifc-lite-clash-revision-baseline', JSON.stringify({ baseline: validBody }));
    assert.strictEqual(loadRevisionBaseline(), null);
  });
});

/** A `ClashRuleCoverage` carrying the #3947 per-element key arrays, sized so
 *  a handful of rules on a broad selector are enough to blow a small quota —
 *  standing in for "a broad rule on a large federated model" from #3953. */
function coverageWithKeys(
  rule: string, matchedA: number, matchedB: number, fromMembersA: boolean, fromMembersB: boolean,
): ClashRuleCoverage {
  const keysA = Array.from({ length: matchedA }, (_, i) => `2N1SPBejP08uMKa3Ea${rule}${String(i).padStart(6, '0')}`);
  const keysB = Array.from({ length: matchedB }, (_, i) => `1O2SPBejP08uMKa3Fb${rule}${String(i).padStart(6, '0')}`);
  return { rule, matchedA, matchedB, fromMembersA, fromMembersB, matchedKeysA: keysA, matchedKeysB: keysB };
}

describe('saveRevisionBaseline size (#3953: matchedKeysA/B growth from #3947)', () => {
  beforeEach(() => {
    g.localStorage = new QuotaLimitedStorage(20_000);
  });

  it(
    'saves successfully under a quota that #3947\'s unstripped matchedKeysA/B would have exceeded, ' +
      'because compareClashRevisions never reads a BASELINE\'s own matchedKeysA/B ' +
      '(revision.ts: ruleMatchedKeys/noMatchRuleIdSet are only ever called on the CURRENT run) ' +
      '— so they are safe to drop before the baseline is persisted',
    () => {
      const r: ClashResult = {
        ...result([clash('m1')]),
        ruleCoverage: [
          coverageWithKeys('r1', 400, 300, true, false),
          coverageWithKeys('r2', 200, 500, false, true),
        ],
      };
      const outcome = saveRevisionBaseline({ result: r, modelNames: { m1: 'building.ifc' }, takenAt: 1000 });
      assert.deepStrictEqual(outcome, { ok: true });

      // And the coverage's small, still-useful fields (counts, fromMembers)
      // survive the round trip — only the unbounded key arrays are gone.
      const loaded = loadRevisionBaseline();
      assert.ok(loaded);
      const coverage = loaded.result.ruleCoverage;
      assert.ok(coverage);
      assert.deepStrictEqual(coverage, [
        { rule: 'r1', matchedA: 400, matchedB: 300, fromMembersA: true, fromMembersB: false },
        { rule: 'r2', matchedA: 200, matchedB: 500, fromMembersA: false, fromMembersB: true },
      ]);
      for (const entry of coverage) {
        assert.strictEqual(Object.hasOwn(entry, 'matchedKeysA'), false);
        assert.strictEqual(Object.hasOwn(entry, 'matchedKeysB'), false);
      }
    },
  );

  it('a baseline with no ruleCoverage at all still round-trips (nothing to strip)', () => {
    const outcome = saveRevisionBaseline({ result: result([clash('m1')]), modelNames: { m1: 'building.ifc' }, takenAt: 1000 });
    assert.deepStrictEqual(outcome, { ok: true });
    assert.strictEqual(loadRevisionBaseline()?.result.ruleCoverage, undefined);
  });
});

describe('captureModelNames (#3928)', () => {
  it('maps every model id referenced by the result to its live display name', () => {
    const r = result([clash('m1')]);
    const models = new Map([['m1', { name: 'architecture.ifc' }], ['m2', { name: 'unrelated.ifc' }]]);
    assert.deepStrictEqual(captureModelNames(r, models), { m1: 'architecture.ifc' });
  });

  it('a model referenced by a clash but no longer in the live model map is omitted, not fabricated', () => {
    const r = result([clash('m1')]);
    assert.deepStrictEqual(captureModelNames(r, new Map()), {});
  });

  it('an empty result maps to an empty record', () => {
    assert.deepStrictEqual(captureModelNames(result([]), new Map()), {});
  });
});
