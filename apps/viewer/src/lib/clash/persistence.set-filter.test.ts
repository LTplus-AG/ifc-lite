/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Persisted clash rules keep loading after #3902 added per-side advanced
 * filters, and the new fields survive a round trip.
 *
 * There is no version bump and no migration step, which is a claim this file
 * has to earn: the two fields are OPTIONAL and absent means "this side is
 * described by its type selector", which is exactly what every preset written
 * before #3902 means. The tests below pin both directions — an old blob loads
 * unchanged, and a blob whose filter is garbage loads as an old one rather
 * than as a half-built filter.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { CLASH_RULE_PRESETS } from '@ifc-lite/clash';
import { buildInitialPresets, presetsToStore, savePresets, type ClashPreset } from './persistence.js';
import { Rule } from '../search/filter-rules.js';
import type { ClashSetFilter } from './set-filter.js';

const PRESETS_KEY = 'ifc-lite-clash-presets';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  get length(): number { return this.store.size; }
  key(i: number): string | null { return [...this.store.keys()][i] ?? null; }
}

const g = globalThis as { localStorage?: unknown };

/** Exactly the shape a build before #3902 wrote: no filter fields anywhere. */
const LEGACY_CUSTOM = {
  id: 'custom-legacy',
  name: 'Ducts vs beams',
  description: '',
  severity: 'major',
  selectorA: 'IfcDuct*',
  selectorB: 'IfcBeam',
  enabled: true,
  builtin: false,
};

const FILTER: ClashSetFilter = {
  combinator: 'AND',
  rules: [Rule.ifcType(['IfcWall']), Rule.property('Pset_WallCommon', 'IsExternal', 'eq', 'true')],
};

function write(presets: unknown[]): void {
  (g.localStorage as MemoryStorage).setItem(PRESETS_KEY, JSON.stringify({ version: 1, presets }));
}

function loadCustom(id: string): ClashPreset | undefined {
  return buildInitialPresets().find((p) => p.id === id);
}

beforeEach(() => {
  g.localStorage = new MemoryStorage();
});

describe('stored clash rules from before per-side filters', () => {
  it('loads a legacy custom rule untouched, with no filters', () => {
    write([LEGACY_CUSTOM]);
    const loaded = loadCustom('custom-legacy');
    assert.ok(loaded);
    assert.strictEqual(loaded.selectorA, 'IfcDuct*');
    assert.strictEqual(loaded.selectorB, 'IfcBeam');
    assert.strictEqual(loaded.filterA, undefined);
    assert.strictEqual(loaded.filterB, undefined);
    assert.ok(!('filterA' in loaded), 'an absent filter must not materialise as an undefined field');
  });

  it('loads the built-ins untouched', () => {
    write([LEGACY_CUSTOM]);
    const builtin = buildInitialPresets().find((p) => p.id === CLASH_RULE_PRESETS[0].id);
    assert.ok(builtin);
    assert.strictEqual(builtin.selectorA, CLASH_RULE_PRESETS[0].selectorA);
    assert.strictEqual(builtin.filterA, undefined);
  });
});

describe('per-side filters round trip through storage', () => {
  it('saves and reloads both sides', () => {
    const preset: ClashPreset = { ...LEGACY_CUSTOM, severity: 'major', filterA: FILTER, filterB: FILTER };
    assert.ok(savePresets([preset]).ok);
    const loaded = loadCustom('custom-legacy');
    assert.deepStrictEqual(loaded?.filterA, FILTER);
    assert.deepStrictEqual(loaded?.filterB, FILTER);
  });

  it('drops a filter that is not readable, keeping the rule itself', () => {
    // A truncated / hand-edited / newer-app entry. The rule must still load
    // and run off its selector rather than vanish or half-load.
    write([{ ...LEGACY_CUSTOM, filterA: { combinator: 'AND', rules: [{ kind: 'nope' }] }, filterB: 'IfcWall' }]);
    const loaded = loadCustom('custom-legacy');
    assert.ok(loaded);
    assert.strictEqual(loaded.filterA, undefined);
    assert.strictEqual(loaded.filterB, undefined);
    assert.strictEqual(loaded.selectorA, 'IfcDuct*');
  });

  it('stores a BUILT-IN that differs only by a filter', () => {
    // `presetsToStore` keeps built-ins only when they differ from the shipped
    // default. Before #3902 the comparison had no filter term, so a filter
    // added to a built-in would have been silently dropped on save.
    const builtins = buildInitialPresets().filter((p) => p.builtin);
    const edited = builtins.map((p) => (p.id === builtins[0].id ? { ...p, filterA: FILTER } : p));
    const stored = presetsToStore(edited);
    assert.deepStrictEqual(stored.map((p) => p.id), [builtins[0].id]);
    assert.deepStrictEqual(stored[0].filterA, FILTER);
  });
});
