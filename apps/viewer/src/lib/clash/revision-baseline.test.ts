/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { Clash, ClashResult } from '@ifc-lite/clash';
import { captureModelNames, loadRevisionBaseline, saveRevisionBaseline } from './revision-baseline.js';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
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
