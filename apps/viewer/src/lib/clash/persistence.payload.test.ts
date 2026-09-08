/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The payload layer: the single functions that build the strings handed to
 * `localStorage.setItem`, and the comparisons built on top of them.
 *
 * `savePresets` used to inline its `JSON.stringify` in the same `try` as the
 * `setItem`; the serialize half is now `presetsPayload(...) === null`, and
 * `presetsStoreIdentically` compares two rule sets through that same builder so
 * a caller asking "would this write change the stored bytes?" compares what
 * would actually be written. Both halves were unpinned: no test anywhere
 * asserted `reason: 'serialize'`, and turning `presetsPayload`'s failure return
 * from `null` into `''` — which makes `savePresets` store an empty string and
 * report success — left every clash test passing.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import {
  buildInitialPresets,
  loadSettings,
  savePresets,
  saveSettings,
  presetsStoreIdentically,
  settingsAlreadyStored,
  DEFAULT_CLASH_SETTINGS,
  type ClashGlobalSettings,
  type ClashPreset,
} from './persistence.js';

class MemoryStorage {
  readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
}

const g = globalThis as { localStorage?: unknown };
const PRESETS_KEY = 'ifc-lite-clash-presets';
const SETTINGS_KEY = 'ifc-lite-clash-settings';

function customPreset(id: string): ClashPreset {
  return {
    id,
    name: `Rule ${id}`,
    description: '',
    severity: 'major',
    selectorA: 'IfcWall',
    selectorB: 'IfcDoor',
    enabled: true,
    builtin: false,
  };
}

/**
 * A preset `JSON.stringify` refuses: a BigInt field throws rather than being
 * dropped or coerced, so the whole payload cannot be built. Cast because the
 * type forbids it — the point is what the writer does when the value it is
 * handed is not the value the type promised.
 */
function unserializablePreset(id: string): ClashPreset {
  return { ...customPreset(id), description: 1n as unknown as string };
}

describe('clash persistence: the presets payload is the single source of the stored bytes', () => {
  let ls: MemoryStorage;

  beforeEach(() => {
    ls = new MemoryStorage();
    g.localStorage = ls;
    // Clear persistence.ts's module-level unwritable latches with a clean read
    // (see the `after` hook in persistence.unreadable.test.ts — every file in
    // this app shares one process and therefore one copy of that Set).
    buildInitialPresets();
    loadSettings();
  });

  it('refuses a rule set it cannot serialize, and stores nothing', () => {
    // Premise: an ordinary rule set through the same call does store.
    assert.deepStrictEqual(savePresets([customPreset('custom-ok')]), { ok: true });
    const stored = ls.getItem(PRESETS_KEY);
    assert.ok(stored && stored.includes('custom-ok'), 'the control write must have landed');

    const result = savePresets([unserializablePreset('custom-bad')]);

    assert.strictEqual(result.ok, false, 'an unserializable rule set must not report success');
    assert.strictEqual(
      !result.ok && result.reason,
      'serialize',
      'the refusal must name serialization, not quota or an unreadable entry',
    );
    // ...and it is a clean no-op: the key still holds the previous rule set,
    // byte for byte. A writer that stored a placeholder for the payload it
    // could not build would also report a failure, and would still have
    // destroyed the user's rules.
    assert.strictEqual(
      ls.getItem(PRESETS_KEY),
      stored,
      'the refused write must leave the stored rule set untouched',
    );

    // The key must also still be readable: storing an empty string (or any
    // non-JSON placeholder) would make the next load throw and latch the key
    // unwritable, turning a refused save into a permanently blocked one.
    assert.ok(
      buildInitialPresets().some((p) => p.id === 'custom-ok'),
      'the stored rule set must still load after the refused write',
    );
  });

  it('reports a rule set that cannot be serialized as differing from itself', () => {
    // Premise: the comparison does answer "identical" for a rule set that can
    // be serialized, so a blanket `false` cannot pass this test.
    const fine = [customPreset('custom-ok')];
    assert.strictEqual(presetsStoreIdentically(fine, [...fine]), true);

    const broken = [unserializablePreset('custom-bad')];
    assert.strictEqual(
      presetsStoreIdentically(broken, broken),
      false,
      'nothing can be concluded about bytes that cannot be built — not even that they match themselves',
    );
    assert.strictEqual(presetsStoreIdentically(broken, fine), false);
    assert.strictEqual(presetsStoreIdentically(fine, broken), false);
  });

  it('ignores built-ins that match their default when comparing stored bytes', () => {
    // The reason this comparison cannot be a structural or reference one:
    // `presetsToStore` drops unmodified built-ins, so two rule sets that differ
    // as arrays still write the same bytes.
    const withBuiltins = buildInitialPresets();
    const customsOnly = withBuiltins.filter((p) => !p.builtin);
    assert.notStrictEqual(withBuiltins.length, customsOnly.length, 'the arrays must really differ');
    assert.strictEqual(presetsStoreIdentically(withBuiltins, customsOnly), true);
  });
});

describe('clash persistence: settingsAlreadyStored compares the bytes saveSettings writes', () => {
  let ls: MemoryStorage;

  beforeEach(() => {
    ls = new MemoryStorage();
    g.localStorage = ls;
    buildInitialPresets();
    loadSettings();
  });

  it('is true exactly when the key already holds what the write would produce', () => {
    // Nothing stored yet: a write would change the key.
    assert.strictEqual(settingsAlreadyStored(DEFAULT_CLASH_SETTINGS), false);

    assert.deepStrictEqual(saveSettings(DEFAULT_CLASH_SETTINGS), { ok: true });
    const written = ls.getItem(SETTINGS_KEY);

    // A distinct object with the same field values: the comparison is on the
    // bytes, not on object identity.
    assert.strictEqual(settingsAlreadyStored({ ...DEFAULT_CLASH_SETTINGS }), true);
    // One differing field is enough to make it a real write.
    assert.strictEqual(
      settingsAlreadyStored({ ...DEFAULT_CLASH_SETTINGS, tolerance: 0.5 }),
      false,
    );
    assert.strictEqual(
      settingsAlreadyStored({ ...DEFAULT_CLASH_SETTINGS, reportTouch: !DEFAULT_CLASH_SETTINGS.reportTouch }),
      false,
    );
    assert.strictEqual(ls.getItem(SETTINGS_KEY), written, 'the comparison must not write anything');
  });

  /**
   * The axis "compared through the same builder" does NOT cover.
   *
   * `settingsPayload` is shared, but `JSON.stringify` takes its key order from
   * the object it is handed, and the two production settings objects are built
   * by two unshared object literals in two files: `snapshotSettings`
   * (`store/slices/clashSlice.ts`), the only producer of the bytes on disk, and
   * `normalizeSettings` (this file), the only producer of the object a flavor
   * carries (via `deserializeClashConfig`). They agree today by convention
   * alone. Let either literal be reordered — a field moved while editing, a new
   * field appended on one side and inserted on the other — and a comparison
   * that rode on key order would answer `false` forever, silently turning every
   * caller of this into dead code with no test able to see it.
   *
   * So the property under test is the values, not the order they were written
   * in. Both sides here are built field by field, in deliberately different
   * orders, rather than one spread from the other: a spread inherits the seed's
   * key order and therefore cannot observe this at all.
   */
  it('compares the settings, not the order the producer happened to build them in', () => {
    const writerOrder: ClashGlobalSettings = {
      mode: DEFAULT_CLASH_SETTINGS.mode,
      tolerance: DEFAULT_CLASH_SETTINGS.tolerance,
      clearance: DEFAULT_CLASH_SETTINGS.clearance,
      duplicateTolerance: DEFAULT_CLASH_SETTINGS.duplicateTolerance,
      clusterEpsilon: DEFAULT_CLASH_SETTINGS.clusterEpsilon,
      reportTouch: DEFAULT_CLASH_SETTINGS.reportTouch,
      groupBy: DEFAULT_CLASH_SETTINGS.groupBy,
    };
    const readerOrder: ClashGlobalSettings = {
      groupBy: DEFAULT_CLASH_SETTINGS.groupBy,
      reportTouch: DEFAULT_CLASH_SETTINGS.reportTouch,
      clusterEpsilon: DEFAULT_CLASH_SETTINGS.clusterEpsilon,
      duplicateTolerance: DEFAULT_CLASH_SETTINGS.duplicateTolerance,
      clearance: DEFAULT_CLASH_SETTINGS.clearance,
      tolerance: DEFAULT_CLASH_SETTINGS.tolerance,
      mode: DEFAULT_CLASH_SETTINGS.mode,
    };
    // Premise: same settings, genuinely different key orders.
    assert.deepStrictEqual(writerOrder, readerOrder, 'the two objects must carry the same settings');
    assert.notDeepStrictEqual(
      Object.keys(writerOrder),
      Object.keys(readerOrder),
      'the two objects must really have been built in different orders',
    );

    // What the writer stores cannot depend on it either: whichever object it is
    // handed, the key holds the same bytes, so a reordered producer does not
    // start rewriting a key that already holds the same settings.
    assert.deepStrictEqual(saveSettings(writerOrder), { ok: true });
    const fromWriterOrder = ls.getItem(SETTINGS_KEY);
    assert.deepStrictEqual(saveSettings(readerOrder), { ok: true });
    assert.strictEqual(ls.getItem(SETTINGS_KEY), fromWriterOrder);

    // ...and the comparison answers on the settings, in both directions.
    assert.strictEqual(settingsAlreadyStored(writerOrder), true);
    assert.strictEqual(settingsAlreadyStored(readerOrder), true);
    assert.deepStrictEqual(saveSettings(writerOrder), { ok: true });
    assert.strictEqual(settingsAlreadyStored(readerOrder), true);

    // Not weakened into a wrong `true`: this stays a byte comparison against
    // what the write would produce, so one differing VALUE is still a write.
    assert.strictEqual(settingsAlreadyStored({ ...readerOrder, tolerance: 0.5 }), false);
    assert.strictEqual(settingsAlreadyStored({ ...writerOrder, mode: 'clearance' }), false);
  });

  it('is false for a stored blob that parses to the same settings but different bytes', () => {
    // A legacy / hand-edited entry can normalize to exactly these settings
    // while holding other bytes. The write would then really change the key,
    // so the answer must be "not already stored" — the conservative direction:
    // a caller uses this to skip a refused write, and skipping one that would
    // have changed the stored bytes is the failure that matters.
    ls.setItem(SETTINGS_KEY, JSON.stringify(DEFAULT_CLASH_SETTINGS)); // no wrapper
    assert.deepStrictEqual(loadSettings(), DEFAULT_CLASH_SETTINGS, 'premise: it loads as these settings');
    assert.strictEqual(settingsAlreadyStored(DEFAULT_CLASH_SETTINGS), false);
  });

  it('is false when there is no storage at all', () => {
    g.localStorage = undefined;
    assert.strictEqual(settingsAlreadyStored(DEFAULT_CLASH_SETTINGS), false);
  });

  // The test above leaves `localStorage` absent, and every file in this app
  // shares one `tsx --test` process: hand the next file a working storage.
  after(() => {
    g.localStorage = new MemoryStorage();
    buildInitialPresets();
    loadSettings();
  });
});
