/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage for lensSlice actions #2802 left untested: the plain UI setters,
 * the derived-getters, and — the interesting one — `setSavedLenses`'s
 * active-pointer bookkeeping, which is the exact sibling of the #2765
 * `deleteLens` defect (a stale `activeLensId` surviving a set that dropped
 * the lens it pointed at).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { Lens } from '@ifc-lite/lens';
import { createLensSlice, type LensSlice } from './lensSlice.js';

function installStubStorage(): Map<string, string> {
  const data = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() { return data.size; },
  } as Storage;
  return data;
}

const LENS: Lens = {
  id: 'lens-test-1',
  name: 'Test lens',
  rules: [{ id: 'r1', name: 'walls', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcWall' }, action: 'colorize', color: '#ff0000' }],
};

function makeSlice(): { get: () => LensSlice } {
  let state: LensSlice;
  const set = (partial: unknown) => {
    const next = typeof partial === 'function'
      ? (partial as (s: LensSlice) => Partial<LensSlice>)(state)
      : partial as Partial<LensSlice>;
    state = { ...state, ...next };
  };
  state = createLensSlice(set as never, () => state, {} as never);
  return { get: () => state };
}

describe('lensSlice - setSavedLenses active-pointer bookkeeping', () => {
  beforeEach(() => { installStubStorage(); });

  it('clears activeLensId when the incoming snapshot drops the active lens (sibling of #2765)', () => {
    const slice = makeSlice();
    slice.get().createLens(LENS);
    slice.get().setActiveLens(LENS.id);
    assert.equal(slice.get().activeLensId, LENS.id, 'precondition');

    // Incoming snapshot (e.g. a flavor switch) no longer contains LENS.
    const result = slice.get().setSavedLenses([]);

    assert.equal(result.ok, true);
    assert.equal(slice.get().activeLensId, null,
      'a snapshot that dropped the active lens must not leave a dangling pointer');
  });

  it('keeps activeLensId when the incoming snapshot still contains it (bounding control)', () => {
    // Clearing unconditionally would also satisfy the assertion above while
    // deselecting the user's lens on every flavor switch.
    const slice = makeSlice();
    slice.get().createLens(LENS);
    slice.get().setActiveLens(LENS.id);

    const result = slice.get().setSavedLenses([LENS]);

    assert.equal(result.ok, true);
    assert.equal(slice.get().activeLensId, LENS.id);
  });

  it('restores missing builtins even when the incoming snapshot omits them', () => {
    const slice = makeSlice();
    const builtinCountBefore = slice.get().savedLenses.filter((l) => l.builtin).length;
    assert.ok(builtinCountBefore > 0, 'precondition: builtins are seeded');

    slice.get().setSavedLenses([LENS]);

    const after = slice.get().savedLenses;
    assert.equal(after.filter((l) => l.builtin).length, builtinCountBefore,
      'builtins missing from the incoming set must be restored from defaults');
    assert.ok(after.some((l) => l.id === LENS.id));
  });
});

describe('lensSlice - plain UI setters', () => {
  beforeEach(() => { installStubStorage(); });

  it('setActiveLens sets and clears the pointer', () => {
    const slice = makeSlice();
    slice.get().setActiveLens('some-id');
    assert.equal(slice.get().activeLensId, 'some-id');
    slice.get().setActiveLens(null);
    assert.equal(slice.get().activeLensId, null);
  });

  it('toggleLensPanel flips visibility from either starting state', () => {
    const slice = makeSlice();
    assert.equal(slice.get().lensPanelVisible, false);
    slice.get().toggleLensPanel();
    assert.equal(slice.get().lensPanelVisible, true);
    slice.get().toggleLensPanel();
    assert.equal(slice.get().lensPanelVisible, false);
  });

  it('setLensPanelVisible sets an explicit value regardless of current state', () => {
    const slice = makeSlice();
    slice.get().setLensPanelVisible(true);
    assert.equal(slice.get().lensPanelVisible, true);
    slice.get().setLensPanelVisible(true);
    assert.equal(slice.get().lensPanelVisible, true);
    slice.get().setLensPanelVisible(false);
    assert.equal(slice.get().lensPanelVisible, false);
  });

  it('setLensColorMap replaces the map wholesale', () => {
    const slice = makeSlice();
    const map = new Map<number, string>([[1, '#fff']]);
    slice.get().setLensColorMap(map);
    assert.strictEqual(slice.get().lensColorMap, map);
  });

  it('setLensAppliedColors accepts a map or null', () => {
    const slice = makeSlice();
    const map = new Map<number, [number, number, number, number]>([[1, [1, 0, 0, 1]]]);
    slice.get().setLensAppliedColors(map);
    assert.strictEqual(slice.get().lensAppliedColors, map);
    slice.get().setLensAppliedColors(null);
    assert.equal(slice.get().lensAppliedColors, null);
  });

  it('setLensHiddenIds replaces the set wholesale', () => {
    const slice = makeSlice();
    const ids = new Set([1, 2, 3]);
    slice.get().setLensHiddenIds(ids);
    assert.strictEqual(slice.get().lensHiddenIds, ids);
  });

  it('setLensAppliedHiddenIds replaces the array wholesale', () => {
    const slice = makeSlice();
    slice.get().setLensAppliedHiddenIds([1, 2]);
    assert.deepStrictEqual(slice.get().lensAppliedHiddenIds, [1, 2]);
    slice.get().setLensAppliedHiddenIds([]);
    assert.deepStrictEqual(slice.get().lensAppliedHiddenIds, []);
  });

  it('setLensRuleIsolation sets and releases isolation', () => {
    const slice = makeSlice();
    const isolation = { ruleId: 'r1', entityIds: [10, 20] };
    slice.get().setLensRuleIsolation(isolation);
    assert.deepStrictEqual(slice.get().lensRuleIsolation, isolation);
    slice.get().setLensRuleIsolation(null);
    assert.equal(slice.get().lensRuleIsolation, null);
  });

  it('setLensRuleCounts and setLensRuleEntityIds replace their maps', () => {
    const slice = makeSlice();
    const counts = new Map([['r1', 5]]);
    const ids = new Map([['r1', [1, 2, 3, 4, 5]]]);
    slice.get().setLensRuleCounts(counts);
    slice.get().setLensRuleEntityIds(ids);
    assert.strictEqual(slice.get().lensRuleCounts, counts);
    assert.strictEqual(slice.get().lensRuleEntityIds, ids);
  });

  it('setLensAutoColorLegend replaces the legend array', () => {
    const slice = makeSlice();
    const legend = [{ value: 'a', color: '#fff', count: 1 }];
    slice.get().setLensAutoColorLegend(legend);
    assert.strictEqual(slice.get().lensAutoColorLegend, legend);
  });

  it('setDiscoveredLensData sets and clears the discovered-data snapshot', () => {
    const slice = makeSlice();
    const data = { classes: ['IfcWall'], psets: [], quantities: [], materials: [] } as never;
    slice.get().setDiscoveredLensData(data);
    assert.strictEqual(slice.get().discoveredLensData, data);
    slice.get().setDiscoveredLensData(null);
    assert.equal(slice.get().discoveredLensData, null);
  });
});

describe('lensSlice - mergeDiscoveredData', () => {
  beforeEach(() => { installStubStorage(); });

  it('is a no-op when nothing has been discovered yet', () => {
    const slice = makeSlice();
    assert.equal(slice.get().discoveredLensData, null);
    slice.get().mergeDiscoveredData({ classes: ['IfcWall'] } as never);
    assert.equal(slice.get().discoveredLensData, null,
      'merging into a null snapshot must not fabricate one');
  });

  it('shallow-merges a patch into the existing snapshot, keeping untouched fields', () => {
    const slice = makeSlice();
    slice.get().setDiscoveredLensData({ classes: ['IfcWall'], psets: ['P1'] } as never);
    slice.get().mergeDiscoveredData({ psets: ['P1', 'P2'] } as never);
    assert.deepStrictEqual(slice.get().discoveredLensData, { classes: ['IfcWall'], psets: ['P1', 'P2'] });
  });
});

describe('lensSlice - getActiveLens / exportLenses', () => {
  beforeEach(() => { installStubStorage(); });

  it('getActiveLens returns null when nothing is active', () => {
    const slice = makeSlice();
    assert.equal(slice.get().getActiveLens(), null);
  });

  it('getActiveLens returns the lens matching activeLensId', () => {
    const slice = makeSlice();
    slice.get().createLens(LENS);
    slice.get().setActiveLens(LENS.id);
    assert.equal(slice.get().getActiveLens()?.id, LENS.id);
  });

  it('getActiveLens returns null for a dangling id pointing at nothing', () => {
    const slice = makeSlice();
    slice.get().setActiveLens('no-such-lens');
    assert.equal(slice.get().getActiveLens(), null);
  });

  it('exportLenses drops the ephemeral auto-color-from-list lens', () => {
    const slice = makeSlice();
    slice.get().activateAutoColorFromColumn({ source: 'attribute', attribute: 'Name' } as never, 'Name');
    const exported = slice.get().exportLenses();
    assert.ok(!exported.some((l) => l.id === 'auto-color-from-list'),
      'the ephemeral lens must not round-trip through export/import');
  });

  it('exportLenses strips runtime-only fields, keeping id/name/rules/autoColor', () => {
    const slice = makeSlice();
    slice.get().createLens(LENS);
    const exported = slice.get().exportLenses().find((l) => l.id === LENS.id);
    assert.ok(exported);
    assert.deepStrictEqual(Object.keys(exported!).sort(), ['id', 'name', 'rules'].sort());
  });
});

describe('lensSlice - activateAutoColorFromColumn', () => {
  beforeEach(() => { installStubStorage(); });

  it('creates and activates an ephemeral auto-color lens, opening the panel', () => {
    const slice = makeSlice();
    slice.get().activateAutoColorFromColumn({ source: 'attribute', attribute: 'Level' } as never, 'Level');
    assert.equal(slice.get().activeLensId, 'auto-color-from-list');
    assert.equal(slice.get().lensPanelVisible, true);
    assert.ok(slice.get().savedLenses.some((l) => l.id === 'auto-color-from-list'));
  });

  it('replaces a previous ephemeral lens rather than accumulating duplicates', () => {
    const slice = makeSlice();
    slice.get().activateAutoColorFromColumn({ source: 'attribute', attribute: 'Level' } as never, 'Level');
    slice.get().activateAutoColorFromColumn({ source: 'attribute', attribute: 'Material' } as never, 'Material');
    const matches = slice.get().savedLenses.filter((l) => l.id === 'auto-color-from-list');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].name, 'Color by Material');
  });
});
