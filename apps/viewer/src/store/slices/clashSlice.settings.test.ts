/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A refused detection-settings write must not be silent.
 *
 * `persistSettings` used to call `saveSettings(...)` and drop the `SaveResult`,
 * so with localStorage over quota or blocked entirely the user's tolerance (or
 * mode, clearance, cluster radius, grazing-contacts, grouping) looked applied
 * and reverted on the next reload with nothing said.
 *
 * The remedy is a one-shot session notice rather than gating the `set`: these
 * setters feed controlled inputs, so refusing to commit would freeze the field
 * the user is typing into, and they fire per keystroke, so an ungated notice
 * would repeat. These tests pin all three properties — reported, reported ONCE,
 * and still committed — plus the quiet path when the write succeeds.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createClashSlice, type ClashSlice } from './clashSlice.js';
import {
  setClashSettingsSaveReporter,
  reportClashSettingsSaveFailure,
} from '@/lib/clash/settings-save-notice.js';

const SETTINGS_KEY = 'ifc-lite-clash-settings';
const PRESETS_KEY = 'ifc-lite-clash-presets';

/**
 * A real, working storage that can be told to refuse writes to ONE key. Reads
 * always work and every other key keeps writing, so the code under test still
 * sees a functioning localStorage: a stub that threw on every `setItem` would
 * make the whole persistence layer look absent and pass for the wrong reason.
 */
class MemoryStorage {
  private store = new Map<string, string>();
  /** Key whose `setItem` throws, mimicking a quota / blocked-storage refusal. */
  failKey: string | null = null;
  /** Every successful write, in order (lets a test prove nothing persisted). */
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

/** A tolerance no default would produce, so "loaded from storage" is provable. */
const SEEDED_TOLERANCE = 0.037;

function seedStoredSettings(storage: MemoryStorage): void {
  storage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      schemaVersion: 1,
      settings: {
        mode: 'hard',
        tolerance: SEEDED_TOLERANCE,
        clearance: 0.05,
        clusterEpsilon: 1.5,
        reportTouch: false,
        groupBy: 'severity',
      },
    }),
  );
  storage.writes.length = 0; // the seed is setup, not a write under test
}

describe('ClashSlice detection settings - a refused write is reported once', () => {
  let storage: MemoryStorage;
  let state: ClashSlice;
  let notices: string[];
  let restoreReporter: () => void;

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
    seedStoredSettings(storage);
    notices = [];
    restoreReporter = setClashSettingsSaveReporter((m) => notices.push(m));
    build();
  });

  afterEach(() => {
    restoreReporter();
  });

  it('the stub is selective: only the settings key refuses, other keys round-trip', () => {
    storage.failKey = SETTINGS_KEY;
    assert.throws(() => storage.setItem(SETTINGS_KEY, 'x'));
    storage.setItem(PRESETS_KEY, 'y');
    assert.strictEqual(storage.getItem(PRESETS_KEY), 'y');
    // Reads still work while writes are refused...
    assert.ok(storage.getItem(SETTINGS_KEY)?.includes(String(SEEDED_TOLERANCE)));
    // ...and the slice really did load the seeded settings through the real path,
    // so these tests exercise persistence rather than a storage-less fallback.
    assert.strictEqual(state.clashTolerance, SEEDED_TOLERANCE);
  });

  it('reports the refused write when the tolerance cannot be saved', () => {
    storage.failKey = SETTINGS_KEY;
    state.setClashTolerance(0.5);
    assert.strictEqual(notices.length, 1, 'a refused settings write must tell the user');
    assert.match(notices[0], /not saved/i);
    assert.deepStrictEqual(storage.writes, [], 'nothing was persisted');
  });

  it('still commits the change so the control does not freeze mid-edit', () => {
    storage.failKey = SETTINGS_KEY;
    state.setClashTolerance(0.5);
    assert.strictEqual(state.clashTolerance, 0.5);
    state.setClashMode('clearance');
    assert.strictEqual(state.clashMode, 'clearance');
  });

  it('reports ONCE across many refused writes, including across setters', () => {
    storage.failKey = SETTINGS_KEY;
    // Six keystrokes on the tolerance field, then five other settings.
    for (const v of [0.1, 0.11, 0.111, 0.2, 0.21, 0.3]) state.setClashTolerance(v);
    state.setClashClearance(0.4);
    state.setClashClusterEpsilon(2);
    state.setClashReportTouch(true);
    state.setClashGroupBy('rule');
    state.setClashMode('clearance');
    state.resetClashSettings();
    assert.strictEqual(notices.length, 1, 'the notice must not repeat within a session');
  });

  it('says nothing when the write succeeds, and persists the value', () => {
    state.setClashTolerance(0.25);
    assert.deepStrictEqual(notices, []);
    assert.deepStrictEqual(storage.writes, [SETTINGS_KEY]);
    const stored = JSON.parse(storage.getItem(SETTINGS_KEY) ?? '{}') as {
      settings?: { tolerance?: number };
    };
    assert.strictEqual(stored.settings?.tolerance, 0.25);
  });

  it('stays quiet for successful writes that follow a reported failure', () => {
    storage.failKey = SETTINGS_KEY;
    state.setClashTolerance(0.5);
    assert.strictEqual(notices.length, 1);
    storage.failKey = null;
    state.setClashTolerance(0.6);
    assert.strictEqual(notices.length, 1);
    assert.deepStrictEqual(storage.writes, [SETTINGS_KEY]);
  });

  it('latches per store instance, so a fresh session can report again', () => {
    storage.failKey = SETTINGS_KEY;
    state.setClashTolerance(0.5);
    build(); // new store == new session
    state.setClashTolerance(0.6);
    assert.strictEqual(notices.length, 2);
  });
});

describe('clash settings save-notice reporter', () => {
  it('falls back to console.warn when no reporter is registered', () => {
    const warned: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args);
    };
    try {
      reportClashSettingsSaveFailure('storage is full');
    } finally {
      console.warn = original;
    }
    assert.strictEqual(warned.length, 1);
    assert.match(String(warned[0][0]), /storage is full/);
  });

  it('unregistering restores the console fallback', () => {
    const seen: string[] = [];
    const restore = setClashSettingsSaveReporter((m) => seen.push(m));
    reportClashSettingsSaveFailure('one');
    restore();

    const warned: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args);
    };
    try {
      reportClashSettingsSaveFailure('two');
    } finally {
      console.warn = original;
    }
    assert.deepStrictEqual(seen, ['one']);
    assert.strictEqual(warned.length, 1);
  });

  it('a stale unregister does not detach a reporter registered after it', () => {
    const first: string[] = [];
    const second: string[] = [];
    const restoreFirst = setClashSettingsSaveReporter((m) => first.push(m));
    const restoreSecond = setClashSettingsSaveReporter((m) => second.push(m));
    restoreFirst(); // out-of-order unmount
    reportClashSettingsSaveFailure('x');
    restoreSecond();
    assert.deepStrictEqual(first, []);
    assert.deepStrictEqual(second, ['x']);
  });
});
