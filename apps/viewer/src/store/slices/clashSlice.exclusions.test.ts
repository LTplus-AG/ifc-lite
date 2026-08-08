/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * User-defined clash exclusions in the store.
 *
 * The slice keeps the RAW run output alongside the filtered one, so adding,
 * disabling or removing an exclusion re-derives the visible result (and its
 * groups) without re-running detection — and so a removal genuinely restores
 * the clashes it had been hiding. CRUD is gated on the write landing, matching
 * preset CRUD: a rule shown as saved that a refused write would undo on reload
 * is the bug this file pins.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { Clash, ClashElementRef, ClashResult } from '@ifc-lite/clash';
import { createClashSlice, type ClashSlice } from './clashSlice.js';
import { elementPairExclusion, typeAnyExclusion, typePairExclusion } from '@/lib/clash/exclusions';

const EXCLUSIONS_KEY = 'ifc-lite-clash-exclusions';

class MemoryStorage {
  private store = new Map<string, string>();
  /** Key whose `setItem` throws, mimicking a quota / blocked-storage refusal. */
  failKey: string | null = null;
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (key === this.failKey) throw new DOMException('quota', 'QuotaExceededError');
    this.store.set(key, value);
  }
  removeItem(key: string): void { this.store.delete(key); }
  get length(): number { return this.store.size; }
  key(i: number): string | null { return [...this.store.keys()][i] ?? null; }
}

const g = globalThis as { localStorage?: unknown };

function ref(model: string, key: string, tag: string, name?: string): ClashElementRef {
  return { model, key, tag, ref: 0, ...(name ? { name } : {}) };
}

let seq = 0;
function clash(a: ClashElementRef, b: ClashElementRef): Clash {
  seq += 1;
  return {
    id: `c${seq}`,
    a,
    b,
    rule: 'all-clashes',
    status: 'hard',
    distance: -0.075,
    point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    severity: 'major',
  };
}

const rail1 = ref('m1', 'GUID_RAIL_1', 'IfcRail', 'Rail 1');
const rail2 = ref('m1', 'GUID_RAIL_2', 'IfcRail', 'Rail 2');
const ballast = ref('m1', 'GUID_COURSE_1', 'IfcCourse', 'Ballast');
const beam1 = ref('m1', 'GUID_BEAM_1', 'IfcBeam', 'Beam 1');
const beam2 = ref('m1', 'GUID_BEAM_2', 'IfcBeam', 'Beam 2');

function sampleResult(): ClashResult {
  const clashes = [clash(rail1, ballast), clash(rail2, ballast), clash(beam1, beam2)];
  return {
    clashes,
    summary: {
      total: 3,
      byRule: { 'all-clashes': 3 },
      byTypePair: { 'IfcCourse vs IfcRail': 2, 'IfcBeam vs IfcBeam': 1 },
      bySeverity: { critical: 0, major: 3, minor: 0, info: 0 },
    },
    rulesRun: [],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

/** Build a live slice whose actions see their own committed state. */
function slice(): { get: () => ClashSlice; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  g.localStorage = storage;
  let state: ClashSlice;
  const set = (partial: unknown) => {
    const patch = typeof partial === 'function'
      ? (partial as (s: ClashSlice) => Partial<ClashSlice>)(state)
      : (partial as Partial<ClashSlice>);
    state = { ...state, ...patch };
  };
  state = createClashSlice(set as never, (() => state) as never, {} as never);
  return { get: () => state, storage };
}

describe('user-defined clash exclusions (store)', () => {
  beforeEach(() => {
    g.localStorage = new MemoryStorage();
  });

  it('starts with no exclusions and passes a result through unchanged', () => {
    const s = slice();
    s.get().setClashResult(sampleResult());
    assert.strictEqual(s.get().clashResult?.clashes.length, 3);
    assert.strictEqual(s.get().clashSuppressedCount, 0);
    assert.strictEqual(s.get().clashExclusions.length, 0);
  });

  it('a type-pair exclusion hides every clash of that pair and reports the count', () => {
    const s = slice();
    s.get().setClashResult(sampleResult());
    const rule = typePairExclusion('IfcRail', 'IfcCourse');
    assert.deepStrictEqual(s.get().addClashExclusion(rule), { ok: true });
    assert.strictEqual(s.get().clashResult?.clashes.length, 1);
    assert.strictEqual(s.get().clashSuppressedCount, 2);
    assert.strictEqual(s.get().clashExclusionCounts.get(rule.id), 2);
    // The raw run output is intact, so the rule is undoable without re-running.
    assert.strictEqual(s.get().clashRawResult?.clashes.length, 3);
  });

  it('re-derives the grouped view too, so groups cannot outlive the clashes they hold', () => {
    const s = slice();
    s.get().setClashResult(sampleResult());
    const before = s.get().clashGroups ?? [];
    assert.strictEqual(before.reduce((n, gr) => n + gr.members.length, 0), 3);
    s.get().addClashExclusion(typePairExclusion('IfcRail', 'IfcCourse'));
    const after = s.get().clashGroups ?? [];
    assert.strictEqual(after.reduce((n, gr) => n + gr.members.length, 0), 1);
  });

  it('removing a rule restores the clashes it was hiding', () => {
    const s = slice();
    s.get().setClashResult(sampleResult());
    const rule = typePairExclusion('IfcRail', 'IfcCourse');
    s.get().addClashExclusion(rule);
    assert.deepStrictEqual(s.get().removeClashExclusion(rule.id), { ok: true });
    assert.strictEqual(s.get().clashResult?.clashes.length, 3);
    assert.strictEqual(s.get().clashSuppressedCount, 0);
    assert.strictEqual(s.get().clashExclusions.length, 0);
  });

  it('disabling a rule restores its clashes but keeps the rule and its count', () => {
    const s = slice();
    s.get().setClashResult(sampleResult());
    const rule = typePairExclusion('IfcRail', 'IfcCourse');
    s.get().addClashExclusion(rule);
    assert.deepStrictEqual(s.get().setClashExclusionEnabled(rule.id, false), { ok: true });
    assert.strictEqual(s.get().clashResult?.clashes.length, 3);
    assert.strictEqual(s.get().clashSuppressedCount, 0);
    assert.strictEqual(s.get().clashExclusions.length, 1);
    // Still shows what re-enabling would cost.
    assert.strictEqual(s.get().clashExclusionCounts.get(rule.id), 2);
  });

  it('an element-pair exclusion hides only that pair', () => {
    const s = slice();
    s.get().setClashResult(sampleResult());
    s.get().addClashExclusion(elementPairExclusion(rail1, ballast));
    assert.strictEqual(s.get().clashResult?.clashes.length, 2);
    assert.strictEqual(s.get().clashSuppressedCount, 1);
  });

  it('ignores a duplicate rule (same pair, either order, same kind)', () => {
    const s = slice();
    s.get().addClashExclusion(typePairExclusion('IfcRail', 'IfcCourse'));
    s.get().addClashExclusion(typePairExclusion('IfcCourse', 'IfcRail'));
    assert.strictEqual(s.get().clashExclusions.length, 1);
  });

  it('keeps a specific element pair distinct from the type pair of the same classes', () => {
    const s = slice();
    s.get().addClashExclusion(typePairExclusion('IfcBeam', 'IfcBeam'));
    s.get().addClashExclusion(elementPairExclusion(beam1, beam2));
    assert.strictEqual(s.get().clashExclusions.length, 2);
  });

  it('a one-sided type exclusion hides every clash touching that class', () => {
    const s = slice();
    s.get().setClashResult(sampleResult());
    const rule = typeAnyExclusion('IfcRail');
    assert.deepStrictEqual(s.get().addClashExclusion(rule), { ok: true });
    // Both rail-vs-ballast clashes go; the beam pair stays.
    assert.strictEqual(s.get().clashResult?.clashes.length, 1);
    assert.strictEqual(s.get().clashResult?.clashes[0]?.a.tag, 'IfcBeam');
    assert.strictEqual(s.get().clashSuppressedCount, 2);
    assert.strictEqual(s.get().clashExclusionCounts.get(rule.id), 2);
    assert.strictEqual(s.get().clashRawResult?.clashes.length, 3);
  });

  it('keeps a one-sided rule distinct from the two-sided rule of the same class', () => {
    const s = slice();
    s.get().addClashExclusion(typeAnyExclusion('IfcBeam'));
    s.get().addClashExclusion(typePairExclusion('IfcBeam', 'IfcBeam'));
    assert.strictEqual(s.get().clashExclusions.length, 2);
    // …but a second one-sided rule for the same class is still a duplicate.
    s.get().addClashExclusion(typeAnyExclusion('IfcBeam'));
    assert.strictEqual(s.get().clashExclusions.length, 2);
  });

  it('round-trips a one-sided rule through storage and still applies it', () => {
    const first = slice();
    first.get().addClashExclusion(typeAnyExclusion('IfcRail'));
    // A new slice over the SAME storage — i.e. a page reload. A validator that
    // did not know the new kind would silently drop the rule here.
    let state: ClashSlice;
    const set = (partial: unknown) => {
      const patch = typeof partial === 'function'
        ? (partial as (s: ClashSlice) => Partial<ClashSlice>)(state)
        : (partial as Partial<ClashSlice>);
      state = { ...state, ...patch };
    };
    state = createClashSlice(set as never, (() => state) as never, {} as never);
    assert.strictEqual(state.clashExclusions.length, 1);
    assert.strictEqual(state.clashExclusions[0]?.kind, 'typeAny');
    state.setClashResult(sampleResult());
    assert.strictEqual(state.clashResult?.clashes.length, 1);
    assert.strictEqual(state.clashSuppressedCount, 2);
  });

  it('does not commit an exclusion whose write was refused', () => {
    const s = slice();
    s.storage.failKey = EXCLUSIONS_KEY;
    const res = s.get().addClashExclusion(typePairExclusion('IfcRail', 'IfcCourse'));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(s.get().clashExclusions.length, 0);
  });

  it('does not commit a removal whose write was refused', () => {
    const s = slice();
    const rule = typePairExclusion('IfcRail', 'IfcCourse');
    s.get().addClashExclusion(rule);
    s.storage.failKey = EXCLUSIONS_KEY;
    const res = s.get().removeClashExclusion(rule.id);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(s.get().clashExclusions.length, 1);
  });

  it('reloads persisted exclusions and applies them to the next run', () => {
    const first = slice();
    first.get().addClashExclusion(typePairExclusion('IfcRail', 'IfcCourse'));
    // A new slice over the SAME storage — i.e. a page reload.
    let state: ClashSlice;
    const set = (partial: unknown) => {
      const patch = typeof partial === 'function'
        ? (partial as (s: ClashSlice) => Partial<ClashSlice>)(state)
        : (partial as Partial<ClashSlice>);
      state = { ...state, ...patch };
    };
    state = createClashSlice(set as never, (() => state) as never, {} as never);
    assert.strictEqual(state.clashExclusions.length, 1);
    state.setClashResult(sampleResult());
    assert.strictEqual(state.clashResult?.clashes.length, 1);
    assert.strictEqual(state.clashSuppressedCount, 2);
  });

  it('clearClash drops the raw result too, so a stale run cannot resurface', () => {
    const s = slice();
    s.get().setClashResult(sampleResult());
    s.get().clearClash();
    assert.strictEqual(s.get().clashRawResult, null);
    assert.strictEqual(s.get().clashResult, null);
    assert.strictEqual(s.get().clashSuppressedCount, 0);
    // Exclusions are workspace state (like presets/reviews) and survive.
    assert.strictEqual(s.get().clashExclusions.length, 0);
  });
});
