/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Preset CRUD must only commit what actually persisted.
 *
 * `createClashPreset` / `updateClashPreset` / `importClashPresets` already
 * gate their `set` on `savePresets(...).ok`; `deleteClashPreset`,
 * `setClashPresetEnabled` and `resetClashPresets` used to discard the
 * `SaveResult` and commit unconditionally, so with storage refusing the write
 * (quota, or storage blocked entirely) the panel showed the change as saved and
 * it vanished on reload. These tests pin the gate on all three, and pin that a
 * successful write still commits.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createClashSlice, type ClashSlice } from './clashSlice.js';

const PRESETS_KEY = 'ifc-lite-clash-presets';
const SETTINGS_KEY = 'ifc-lite-clash-settings';

/**
 * A real, working storage that can be told to refuse writes to ONE key. Reads
 * always work and every other key keeps writing, so the module under test still
 * sees a functioning localStorage: a stub that rejected every `setItem` would
 * make the whole persistence layer look absent and pass for the wrong reason.
 */
class MemoryStorage {
  private store = new Map<string, string>();
  /** Key whose `setItem` throws, mimicking a quota / blocked-storage refusal. */
  failKey: string | null = null;
  /** Every successful write, in order (lets a test prove nothing was persisted). */
  writes: string[] = [];
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (key === this.failKey) throw new DOMException('quota', 'QuotaExceededError');
    this.store.set(key, value);
    this.writes.push(key);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  get length(): number {
    return this.store.size;
  }
  key(i: number): string | null {
    return [...this.store.keys()][i] ?? null;
  }
}

const g = globalThis as { localStorage?: unknown };

const CUSTOM_ID = 'custom-seeded-1';
const BUILTIN_ID = 'MEPxSTR'; // first entry of CLASH_RULE_PRESETS

/** Seed storage with one custom preset so `buildInitialPresets()` loads it. */
function seedStoredCustom(storage: MemoryStorage): void {
  storage.setItem(
    PRESETS_KEY,
    JSON.stringify({
      schemaVersion: 1,
      presets: [
        {
          id: CUSTOM_ID,
          name: 'Seeded custom',
          description: '',
          severity: 'major',
          selectorA: 'IfcWall',
          selectorB: 'IfcDoor',
          enabled: true,
        },
      ],
    }),
  );
  storage.writes.length = 0; // the seed is setup, not a write under test
}

describe('ClashSlice preset CRUD - only commit what persisted', () => {
  let storage: MemoryStorage;
  let state: ClashSlice;

  const build = () => {
    const setState = (
      partial: Partial<ClashSlice> | ((s: ClashSlice) => Partial<ClashSlice>),
    ) => {
      state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    };
    state = createClashSlice(setState, () => state, {} as never);
  };

  beforeEach(() => {
    storage = new MemoryStorage();
    g.localStorage = storage;
    seedStoredCustom(storage);
    build();
  });

  it('the stub is selective: only the presets key refuses writes', () => {
    storage.failKey = PRESETS_KEY;
    assert.throws(() => storage.setItem(PRESETS_KEY, 'x'));
    storage.setItem(SETTINGS_KEY, 'y');
    assert.strictEqual(storage.getItem(SETTINGS_KEY), 'y');
    // ...and the slice really did load the seeded custom through the real path.
    assert.ok(state.clashPresets.some((p) => p.id === CUSTOM_ID));
  });

  // ── deleteClashPreset ──────────────────────────────────────────────────────

  it('deleteClashPreset keeps the preset listed when the write is refused', () => {
    storage.failKey = PRESETS_KEY;
    const result = state.deleteClashPreset(CUSTOM_ID);
    assert.ok(
      state.clashPresets.some((p) => p.id === CUSTOM_ID),
      'a delete that did not persist must not disappear from the list',
    );
    assert.deepStrictEqual(storage.writes, []);
    assert.strictEqual(result.ok, false);
    assert.ok(!result.ok && result.message.length > 0);
  });

  it('deleteClashPreset commits and reports ok when the write succeeds', () => {
    const result = state.deleteClashPreset(CUSTOM_ID);
    assert.deepStrictEqual(result, { ok: true });
    assert.ok(!state.clashPresets.some((p) => p.id === CUSTOM_ID));
    assert.deepStrictEqual(storage.writes, [PRESETS_KEY]);
  });

  it('deleteClashPreset is a silent no-op for a built-in / unknown id', () => {
    storage.failKey = PRESETS_KEY; // would throw if it tried to persist
    assert.deepStrictEqual(state.deleteClashPreset(BUILTIN_ID), { ok: true });
    assert.deepStrictEqual(state.deleteClashPreset('nope'), { ok: true });
    assert.deepStrictEqual(storage.writes, []);
    assert.ok(state.clashPresets.some((p) => p.id === BUILTIN_ID));
  });

  // ── setClashPresetEnabled ──────────────────────────────────────────────────

  it('setClashPresetEnabled leaves the toggle unchanged when the write is refused', () => {
    storage.failKey = PRESETS_KEY;
    const result = state.setClashPresetEnabled(BUILTIN_ID, false);
    assert.strictEqual(
      state.clashPresets.find((p) => p.id === BUILTIN_ID)?.enabled,
      true,
      'a toggle that did not persist must stay on',
    );
    assert.deepStrictEqual(storage.writes, []);
    assert.strictEqual(result.ok, false);
  });

  it('setClashPresetEnabled commits and reports ok when the write succeeds', () => {
    const result = state.setClashPresetEnabled(BUILTIN_ID, false);
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(state.clashPresets.find((p) => p.id === BUILTIN_ID)?.enabled, false);
    assert.deepStrictEqual(storage.writes, [PRESETS_KEY]);
  });

  // ── resetClashPresets ──────────────────────────────────────────────────────

  it('resetClashPresets keeps the custom rules when the write is refused', () => {
    storage.failKey = PRESETS_KEY;
    const result = state.resetClashPresets();
    assert.ok(
      state.clashPresets.some((p) => p.id === CUSTOM_ID),
      'a reset that did not persist must not drop the customs from the list',
    );
    assert.deepStrictEqual(storage.writes, []);
    assert.strictEqual(result.ok, false);
  });

  it('resetClashPresets commits and reports ok when the write succeeds', () => {
    const result = state.resetClashPresets();
    assert.deepStrictEqual(result, { ok: true });
    assert.ok(!state.clashPresets.some((p) => p.id === CUSTOM_ID));
    assert.ok(state.clashPresets.every((p) => p.builtin && p.enabled));
    assert.deepStrictEqual(storage.writes, [PRESETS_KEY]);
  });

  // ── siblings: unchanged behaviour ──────────────────────────────────────────

  it('createClashPreset still gates its commit on the SaveResult', () => {
    storage.failKey = PRESETS_KEY;
    const before = state.clashPresets.length;
    const result = state.createClashPreset({
      name: 'New rule',
      severity: 'minor',
      selectorA: 'IfcBeam',
      selectorB: 'IfcSlab',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(state.clashPresets.length, before);

    storage.failKey = null;
    assert.deepStrictEqual(
      state.createClashPreset({ name: 'New rule', severity: 'minor', selectorA: 'IfcBeam', selectorB: 'IfcSlab' }),
      { ok: true },
    );
    assert.strictEqual(state.clashPresets.length, before + 1);
  });

  it('updateClashPreset still gates its commit on the SaveResult', () => {
    storage.failKey = PRESETS_KEY;
    assert.strictEqual(state.updateClashPreset(CUSTOM_ID, { name: 'Renamed' }).ok, false);
    assert.strictEqual(state.clashPresets.find((p) => p.id === CUSTOM_ID)?.name, 'Seeded custom');

    storage.failKey = null;
    assert.deepStrictEqual(state.updateClashPreset(CUSTOM_ID, { name: 'Renamed' }), { ok: true });
    assert.strictEqual(state.clashPresets.find((p) => p.id === CUSTOM_ID)?.name, 'Renamed');
  });

  it('importClashPresets still gates its commit on the SaveResult', () => {
    const incoming = [
      {
        id: 'custom-imported',
        name: 'Imported',
        description: '',
        severity: 'info' as const,
        selectorA: 'IfcPipeSegment',
        selectorB: 'IfcWall',
        enabled: true,
        builtin: false,
      },
    ];
    storage.failKey = PRESETS_KEY;
    assert.strictEqual(state.importClashPresets(incoming).ok, false);
    assert.ok(!state.clashPresets.some((p) => p.id === 'custom-imported'));

    storage.failKey = null;
    assert.deepStrictEqual(state.importClashPresets(incoming), { ok: true });
    assert.ok(state.clashPresets.some((p) => p.id === 'custom-imported'));
  });
});
