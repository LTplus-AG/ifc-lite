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
import type { Clash, ClashElementRef, ClashGroup, ClashResult } from '@ifc-lite/clash';
import { createClashSlice, type ClashSlice } from './clashSlice.js';
import { elementPairExclusion, typeAnyExclusion, typePairExclusion } from '@/lib/clash/exclusions';
import { DEFAULT_CLASH_SETTINGS } from '@/lib/clash/persistence';

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
  return clashAt(a, b, [0, 0, 0]);
}

/** Same as `clash`, but at a caller-chosen point — needed to make cluster
 * grouping (which buckets by distance between `point`s) actually distinguish
 * one epsilon from another. */
function clashAt(a: ClashElementRef, b: ClashElementRef, point: [number, number, number]): Clash {
  seq += 1;
  return {
    id: `c${seq}`,
    a,
    b,
    rule: 'all-clashes',
    status: 'hard',
    distance: -0.075,
    point,
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

/**
 * A run whose cluster radius is observable AND whose exclusions bite: two
 * IfcRail-vs-IfcCourse clashes 5m apart (so 1.5m vs 10m radius groups them
 * differently) plus one IfcBeam-vs-IfcBeam clash for a rule to match.
 *
 * The beam clash is what the three settings-change tests below were missing.
 * With NO rule in play, `clashRawResult` and `clashResult` are the SAME object
 * — `applyClashExclusions` returns its input by reference when nothing is
 * suppressed (exclusions.ts) — so the three `deriveGroups(state,
 * state.clashRawResult, ...)` call sites in `setClashClusterEpsilon`,
 * `resetClashSettings` and `applyClashFlavorConfig` could each be swapped to
 * `state.clashResult` with every test still green. Under that swap the
 * re-derivation runs against the already-filtered set, so `clashSuppressedCount`
 * and every per-rule count collapse to zero the moment the user nudges the
 * cluster radius with an exclusion active — the clash list stays right
 * (re-filtering is idempotent), but the "· N hidden" badge and the per-rule
 * reach silently vanish.
 */
function epsilonResult(): ClashResult {
  const clashes = [
    clashAt(rail1, ballast, [0, 0, 0]),
    clashAt(rail2, ballast, [5, 0, 0]),
    clashAt(beam1, beam2, [0, 0, 0]),
  ];
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

  it('clearClash empties the per-rule suppressed counts with the result', () => {
    // github.com/LTplus-AG/ifc-lite/issues/2765: removing the
    // `clashExclusionCounts` reset from `clearClash` left 23 tests green. The
    // counts are per-RUN tallies displayed next to each rule, so keeping them
    // after the run is cleared shows a rule suppressing clashes that no longer
    // exist, and the tally is then wrong for the next run too.
    const s = slice();
    s.get().setClashResult(sampleResult());
    const rule = typePairExclusion('IfcRail', 'IfcCourse');
    s.get().addClashExclusion(rule);
    assert.strictEqual(s.get().clashExclusionCounts.get(rule.id), 2, 'precondition: a count to clear');

    s.get().clearClash();

    assert.strictEqual(s.get().clashExclusionCounts.size, 0, 'no run, no per-rule tally');
    assert.strictEqual(s.get().clashSuppressedCount, 0);
    assert.strictEqual(s.get().clashResult, null);
    // The RULE itself is a workspace preference and survives, like the presets.
    assert.strictEqual(s.get().clashExclusions.length, 1);
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

  it('setClashClusterEpsilon re-derives clashGroups, so the Issues-view radius control is not inert (#2535)', () => {
    // Two IfcRail-vs-IfcCourse clashes 5m apart. At the default 1.5m radius
    // they are two separate cluster groups; raising the radius past 5m must
    // merge them into one WITHOUT a new detection run — deriveFromExclusions
    // is the only writer of clashGroups, and setClashClusterEpsilon used to
    // never call it, so the control changed the persisted setting but the
    // Issues view never regrouped.
    const s = slice();
    s.get().setClashResult(epsilonResult());
    // An exclusion that actually matches, so the re-derivation has to run
    // against the RAW run rather than its own previous output.
    const rule = typePairExclusion('IfcBeam', 'IfcBeam');
    assert.deepStrictEqual(s.get().addClashExclusion(rule), { ok: true });
    assert.strictEqual(s.get().clashSuppressedCount, 1, 'precondition: the beam pair is hidden');
    assert.strictEqual(s.get().clashExclusionCounts.get(rule.id), 1);
    assert.strictEqual(s.get().clashClusterEpsilon, 1.5, 'default radius');
    assert.strictEqual(s.get().clashGroups?.length, 2, 'default 1.5m radius keeps the two clashes apart');

    s.get().setClashClusterEpsilon(10);

    assert.strictEqual(s.get().clashClusterEpsilon, 10);
    assert.strictEqual(
      s.get().clashGroups?.length,
      1,
      'raising the radius past the 5m gap must merge the two clashes into one group, with no re-run',
    );
    // The filtered result itself must be untouched by a pure view-setting change.
    assert.strictEqual(s.get().clashResult?.clashes.length, 2);
    assert.strictEqual(s.get().clashRawResult?.clashes.length, 3, 'the raw run is never re-filtered in place');
    assert.strictEqual(
      s.get().clashSuppressedCount,
      1,
      'the hidden-clash count must survive a radius change — re-deriving from the FILTERED result would zero it',
    );
    assert.strictEqual(
      s.get().clashExclusionCounts.get(rule.id),
      1,
      "the rule's own reach must survive a radius change too",
    );
  });

  it('resetClashSettings re-derives clashGroups with the default radius (#2535)', () => {
    // Same mechanism as the setClashClusterEpsilon test above, other direction:
    // reset changes the radius back to 1.5m, and the derived grouping must
    // follow immediately; before the fix the reset wrote the setting but the
    // Issues view kept the clusters computed at the old radius until the next
    // run.
    const s = slice();
    s.get().setClashResult(epsilonResult());
    const rule = typePairExclusion('IfcBeam', 'IfcBeam');
    assert.deepStrictEqual(s.get().addClashExclusion(rule), { ok: true });
    s.get().setClashClusterEpsilon(10);
    assert.strictEqual(s.get().clashGroups?.length, 1, 'precondition: 10m radius merges the 5m-apart pair');

    s.get().resetClashSettings();

    assert.strictEqual(s.get().clashClusterEpsilon, DEFAULT_CLASH_SETTINGS.clusterEpsilon);
    assert.strictEqual(
      s.get().clashGroups?.length,
      2,
      'the derived grouping must follow the reset radius immediately, without a re-run',
    );
    // Resetting the DETECTION settings must not silently reset the user's
    // exclusion bookkeeping: the rules themselves are untouched, so their
    // counts must be recomputed from the raw run, not from the filtered one.
    assert.strictEqual(s.get().clashRawResult?.clashes.length, 3);
    assert.strictEqual(s.get().clashSuppressedCount, 1);
    assert.strictEqual(s.get().clashExclusionCounts.get(rule.id), 1);
  });

  it('applyClashFlavorConfig re-derives clashGroups with the flavor radius (#2535)', () => {
    const s = slice();
    s.get().setClashResult(epsilonResult());
    const rule = typePairExclusion('IfcBeam', 'IfcBeam');
    assert.deepStrictEqual(s.get().addClashExclusion(rule), { ok: true });
    assert.strictEqual(s.get().clashGroups?.length, 2, 'precondition: default 1.5m radius keeps the pair apart');

    s.get().applyClashFlavorConfig({
      presets: s.get().clashPresets,
      settings: { ...DEFAULT_CLASH_SETTINGS, clusterEpsilon: 10 },
    });

    assert.strictEqual(s.get().clashClusterEpsilon, 10);
    assert.strictEqual(
      s.get().clashGroups?.length,
      1,
      'activating a flavor must regroup at its radius immediately, without a re-run',
    );
    // A flavor carries detection settings, not exclusions — so the user's
    // rules and their reported reach must come through the switch intact.
    assert.strictEqual(s.get().clashRawResult?.clashes.length, 3);
    assert.strictEqual(s.get().clashSuppressedCount, 1);
    assert.strictEqual(s.get().clashExclusionCounts.get(rule.id), 1);
  });

  it('a settings change leaves a manual duplicate-scan grouping alone (#2535)', () => {
    // The duplicate scan overrides the derived clusters with coincident SETS
    // (clashGroupsKind 'manual'). Re-deriving on a settings change must not
    // clobber that: deriveGroups only replaces a manual grouping for a
    // genuinely new run (newRun: true).
    const s = slice();
    s.get().setClashResult(sampleResult());
    const manual: ClashGroup[] = [
      {
        id: 'set-1',
        title: '3 coincident objects',
        members: s.get().clashResult?.clashes ?? [],
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        representativePoint: [0, 0, 0],
        severity: 'major',
      },
    ];
    s.get().setClashGroups(manual);
    assert.strictEqual(s.get().clashGroupsKind, 'manual');

    s.get().resetClashSettings();
    assert.strictEqual(s.get().clashGroups, manual, 'reset must not clobber a manual grouping');
    assert.strictEqual(s.get().clashGroupsKind, 'manual');

    s.get().applyClashFlavorConfig({
      presets: s.get().clashPresets,
      settings: { ...DEFAULT_CLASH_SETTINGS, clusterEpsilon: 10 },
    });
    assert.strictEqual(s.get().clashGroups, manual, 'a flavor activation must not clobber a manual grouping');
    assert.strictEqual(s.get().clashGroupsKind, 'manual');
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

  it('re-enables a matching DISABLED rule instead of silently no-opping', () => {
    // Failure scenario the fix targets: add "exclude anything touching
    // IfcRail", untick it to see the clashes again, then click the same
    // exclude control on a clash. Before the fix, `exclusionRuleKey` matched
    // the disabled rule and `addClashExclusion` returned `{ ok: true }`
    // without re-enabling it — the button looked broken (no change, no toast).
    const s = slice();
    s.get().setClashResult(sampleResult());
    const rule = typeAnyExclusion('IfcRail');
    s.get().addClashExclusion(rule);
    assert.strictEqual(s.get().clashSuppressedCount, 2);
    s.get().setClashExclusionEnabled(rule.id, false);
    assert.strictEqual(s.get().clashSuppressedCount, 0);
    // Re-"add" the same rule (what the exclude button does on re-click).
    const res = s.get().addClashExclusion(typeAnyExclusion('IfcRail'));
    assert.deepStrictEqual(res, { ok: true });
    assert.strictEqual(s.get().clashExclusions.length, 1, 'still one rule, not a duplicate');
    assert.strictEqual(s.get().clashExclusions[0]?.enabled, true, 'the existing rule must be re-enabled');
    assert.strictEqual(s.get().clashSuppressedCount, 2, 'clashes must be hidden again');
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

  it('round-trips an element-pair rule through storage and still applies it after a model-id change (reload)', () => {
    // The actual bug scenario: `ClashElementRef.model` is the viewer's
    // per-load `crypto.randomUUID()` (useIfcLoader/useIfcFederation mint a
    // fresh one on every load), so a real page reload re-runs detection
    // against elements carrying a DIFFERENT model id even though the durable
    // element keys (GUIDs) are unchanged. A rule keyed on `qualifiedKey(model,
    // key)` would go inert here while still being listed as enabled.
    const first = slice();
    first.get().setClashResult(sampleResult());
    first.get().addClashExclusion(elementPairExclusion(rail1, ballast));
    assert.strictEqual(first.get().clashExclusions.length, 1);
    assert.strictEqual(first.get().clashExclusions[0]?.kind, 'elementPair');

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

    // The post-reload run: same GUIDs, but a NEW model id (a fresh
    // `crypto.randomUUID()`), exactly as a real reload produces.
    const rail1Reloaded = ref('m2-reload', 'GUID_RAIL_1', 'IfcRail', 'Rail 1');
    const rail2Reloaded = ref('m2-reload', 'GUID_RAIL_2', 'IfcRail', 'Rail 2');
    const ballastReloaded = ref('m2-reload', 'GUID_COURSE_1', 'IfcCourse', 'Ballast');
    const beam1Reloaded = ref('m2-reload', 'GUID_BEAM_1', 'IfcBeam', 'Beam 1');
    const beam2Reloaded = ref('m2-reload', 'GUID_BEAM_2', 'IfcBeam', 'Beam 2');
    const reloadedResult: ClashResult = {
      clashes: [
        clash(rail1Reloaded, ballastReloaded),
        clash(rail2Reloaded, ballastReloaded),
        clash(beam1Reloaded, beam2Reloaded),
      ],
      summary: {
        total: 3,
        byRule: { 'all-clashes': 3 },
        byTypePair: { 'IfcCourse vs IfcRail': 2, 'IfcBeam vs IfcBeam': 1 },
        bySeverity: { critical: 0, major: 3, minor: 0, info: 0 },
      },
      rulesRun: [],
      settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
    };
    state.setClashResult(reloadedResult);
    // The rule must still suppress the ONE pair it names, across the model-id
    // change: this is the blocker scenario, and must NOT regress to 0.
    assert.strictEqual(state.clashSuppressedCount, 1);
    assert.strictEqual(state.clashResult?.clashes.length, 2);
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

  it('a stored exclusion with a missing or non-boolean `enabled` must not suppress clashes (#2535)', () => {
    // Fail-open hazard: an exclusion rule's whole job is to HIDE clashes, so a
    // corrupted or partially-written localStorage entry that loads as enabled
    // silently hides real clashes from a coordinator, with no signal. The safe
    // default for a rule we cannot fully trust is that it suppresses nothing:
    // only a literal `enabled: true` may.
    const storage = new MemoryStorage();
    g.localStorage = storage;
    storage.setItem(
      EXCLUSIONS_KEY,
      JSON.stringify({
        schemaVersion: 1,
        exclusions: [
          // `enabled` absent, i.e. a partially-written entry.
          { id: 'x1', kind: 'typePair', a: 'IfcRail', b: 'IfcCourse', label: 'r x c', createdAt: 1 },
          // Truthy non-boolean garbage.
          { id: 'x2', kind: 'typeAny', a: 'IfcBeam', b: 'IfcBeam', label: 'beams', enabled: 'yes', createdAt: 2 },
        ],
      }),
    );
    let state: ClashSlice;
    const set = (partial: unknown) => {
      const patch = typeof partial === 'function'
        ? (partial as (s: ClashSlice) => Partial<ClashSlice>)(state)
        : (partial as Partial<ClashSlice>);
      state = { ...state, ...patch };
    };
    state = createClashSlice(set as never, (() => state) as never, {} as never);
    assert.strictEqual(state.clashExclusions.length, 2, 'the rules themselves are kept, visible in the panel');
    assert.ok(
      state.clashExclusions.every((r) => r.enabled === false),
      'a malformed or absent enabled flag must load as DISABLED',
    );
    state.setClashResult(sampleResult());
    assert.strictEqual(
      state.clashSuppressedCount,
      0,
      'no clash may be hidden by a rule whose enabled flag was malformed or absent',
    );
    assert.strictEqual(state.clashResult?.clashes.length, 3);
    // The reach counts still show what enabling each rule would hide.
    assert.strictEqual(state.clashExclusionCounts.get('x1'), 2);
  });

  it('stored boolean `enabled` values keep their meaning across a reload (#2535)', () => {
    // The fail-closed default above must not defuse VALID persisted rules:
    // exactly what saveExclusions writes (a literal boolean) round-trips.
    const storage = new MemoryStorage();
    g.localStorage = storage;
    storage.setItem(
      EXCLUSIONS_KEY,
      JSON.stringify({
        schemaVersion: 1,
        exclusions: [
          { id: 'on', kind: 'typePair', a: 'IfcRail', b: 'IfcCourse', label: 'r x c', enabled: true, createdAt: 1 },
          { id: 'off', kind: 'typePair', a: 'IfcBeam', b: 'IfcBeam', label: 'beams', enabled: false, createdAt: 2 },
        ],
      }),
    );
    let state: ClashSlice;
    const set = (partial: unknown) => {
      const patch = typeof partial === 'function'
        ? (partial as (s: ClashSlice) => Partial<ClashSlice>)(state)
        : (partial as Partial<ClashSlice>);
      state = { ...state, ...patch };
    };
    state = createClashSlice(set as never, (() => state) as never, {} as never);
    assert.deepStrictEqual(
      state.clashExclusions.map((r) => [r.id, r.enabled]),
      [['on', true], ['off', false]],
    );
    state.setClashResult(sampleResult());
    assert.strictEqual(state.clashSuppressedCount, 2, 'a valid enabled rule must still suppress its pair');
    assert.strictEqual(state.clashResult?.clashes.length, 1);
  });

  it('clearClash drops the raw result too, so a stale run cannot resurface', () => {
    const s = slice();
    s.get().setClashResult(sampleResult());
    // Add a rule BEFORE clearing: the invariant under test is that clearClash
    // does not wipe it too. An empty-list-to-empty-list assertion (never
    // adding one) would still pass if a future edit put `clashExclusions: []`
    // into clearClash's `set` block.
    const rule = typePairExclusion('IfcRail', 'IfcCourse');
    assert.deepStrictEqual(s.get().addClashExclusion(rule), { ok: true });
    assert.strictEqual(s.get().clashExclusions.length, 1);

    s.get().clearClash();
    assert.strictEqual(s.get().clashRawResult, null);
    assert.strictEqual(s.get().clashResult, null);
    assert.strictEqual(s.get().clashSuppressedCount, 0);
    // Exclusions are workspace state (like presets/reviews) and survive.
    assert.strictEqual(s.get().clashExclusions.length, 1);
    assert.strictEqual(s.get().clashExclusions[0]?.id, rule.id);
  });
});
