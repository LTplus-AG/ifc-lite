/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import type { ClashReview } from '@ifc-lite/clash';
import {
  buildInitialPresets,
  savePresets,
  loadReviews,
  saveReviews,
  loadSettings,
  saveSettings,
  DEFAULT_CLASH_SETTINGS,
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
const REVIEWS_KEY = 'ifc-lite-clash-reviews';
const SETTINGS_KEY = 'ifc-lite-clash-settings';

/** Truncated JSON — the shape a half-written or externally mangled entry has. */
const CORRUPT_PRESETS = '{"schemaVersion":1,"presets":[{"id":"custom-1","name":"My rule"';
const CORRUPT_REVIEWS = '{"schemaVersion":1,"reviews":{"rule-a G1 G2":{"status":"resol';
const CORRUPT_SETTINGS = '{"schemaVersion":1,"settings":{"mode":"hard","tolerance":0.5';

/** True when `raw` is still somewhere in storage (original key or a backup). */
function survives(ls: MemoryStorage, raw: string): boolean {
  return [...ls.store.values()].includes(raw);
}

const customPreset: ClashPreset = {
  id: 'custom-new',
  name: 'Ducts vs beams',
  description: '',
  severity: 'major',
  selectorA: 'IfcDuctSegment',
  selectorB: 'IfcBeam',
  enabled: true,
  builtin: false,
};

describe('clash persistence: an unreadable entry is never overwritten', () => {
  let ls: MemoryStorage;
  beforeEach(() => {
    ls = new MemoryStorage();
    g.localStorage = ls;
    // Clear the module-level "unwritable" flags via a clean read of empty storage.
    buildInitialPresets();
    loadReviews();
    loadSettings();
  });

  after(() => {
    // The last test in this suite deliberately leaves both keys latched
    // unwritable (the backup write itself fails). `apps/viewer` runs every
    // test file in one `tsx --test` process, so persistence.ts's
    // module-level `unwritableKeys` would otherwise carry that latch into
    // whichever test file runs next and imports it — `savePresets`/
    // `saveReviews` check the flag before ever touching storage, so a later
    // file's first save (not preceded by its own clean read) would be
    // spuriously refused for storage it never actually corrupted. A clean
    // read against ordinary storage clears the flags the same way `beforeEach`
    // does above.
    g.localStorage = new MemoryStorage();
    buildInitialPresets();
    loadReviews();
    loadSettings();
  });

  it('preserves unreadable presets across the save that follows the failed read', () => {
    ls.setItem(PRESETS_KEY, CORRUPT_PRESETS);

    // The read degrades to built-ins only — the user's customs are not visible.
    const presets = buildInitialPresets();
    assert.ok(presets.every((p) => p.builtin), 'expected only built-ins after a failed read');

    // ...and the very next edit persists that degraded list.
    assert.deepStrictEqual(savePresets([...presets, customPreset]), { ok: true });

    assert.ok(survives(ls, CORRUPT_PRESETS), 'the unreadable presets blob was destroyed by the save');
  });

  it('preserves unreadable reviews across the save that follows the failed read', () => {
    ls.setItem(REVIEWS_KEY, CORRUPT_REVIEWS);

    assert.strictEqual(loadReviews().size, 0);
    const map = new Map<string, ClashReview>([['rule-b G3 G4', { status: 'accepted' }]]);
    assert.deepStrictEqual(saveReviews(map), { ok: true });

    assert.ok(survives(ls, CORRUPT_REVIEWS), 'the unreadable reviews blob was destroyed by the save');
  });

  it('preserves unreadable settings across the save that follows the failed read', () => {
    ls.setItem(SETTINGS_KEY, CORRUPT_SETTINGS);

    // The read degrades to defaults — the user's stored tolerance is not visible.
    const loaded = loadSettings();
    assert.deepStrictEqual(loaded, DEFAULT_CLASH_SETTINGS);

    // ...and the very next edit persists that degraded (default) settings —
    // but the original bytes must still be recoverable from a backup key.
    assert.deepStrictEqual(saveSettings({ ...DEFAULT_CLASH_SETTINGS, tolerance: 0.01 }), { ok: true });

    assert.ok(survives(ls, CORRUPT_SETTINGS), 'the unreadable settings blob was destroyed by the save');
  });

  // ── Negative cases: the guard must not turn into "never write again" ────────

  it('still round-trips normally when the stored entry is readable', () => {
    assert.deepStrictEqual(savePresets([customPreset]), { ok: true });
    const reloaded = buildInitialPresets().filter((p) => !p.builtin);
    assert.deepStrictEqual(reloaded.map((p) => p.id), ['custom-new']);
  });

  // Bounding control: a non-corrupt settings entry must still load its stored
  // values and still save successfully — otherwise "refuse everything" would
  // pass this suite too.
  it('still round-trips settings normally when the stored entry is readable', () => {
    const settings = { ...DEFAULT_CLASH_SETTINGS, tolerance: 0.05, mode: 'clearance' as const };
    assert.deepStrictEqual(saveSettings(settings), { ok: true });
    assert.deepStrictEqual(loadSettings(), settings);
  });

  it('keeps saving after an unreadable read — the panel stays usable', () => {
    ls.setItem(PRESETS_KEY, CORRUPT_PRESETS);
    buildInitialPresets();

    assert.deepStrictEqual(savePresets([customPreset]), { ok: true });
    // The new rule must be readable back, not just "not an error".
    assert.deepStrictEqual(
      buildInitialPresets().filter((p) => !p.builtin).map((p) => p.id),
      ['custom-new'],
    );

    // And a user-initiated delete of that rule still deletes it.
    assert.deepStrictEqual(savePresets([]), { ok: true });
    assert.deepStrictEqual(buildInitialPresets().filter((p) => !p.builtin), []);
    // ...while the preserved copy of the unreadable blob is still untouched.
    assert.ok(survives(ls, CORRUPT_PRESETS));
  });

  it('keeps saving reviews after an unreadable read, and honours a clearing edit', () => {
    ls.setItem(REVIEWS_KEY, CORRUPT_REVIEWS);
    loadReviews();

    saveReviews(new Map<string, ClashReview>([['k', { status: 'resolved' }]]));
    assert.strictEqual(loadReviews().get('k')?.status, 'resolved');

    saveReviews(new Map<string, ClashReview>());
    assert.strictEqual(loadReviews().size, 0);
    assert.ok(survives(ls, CORRUPT_REVIEWS));
  });

  it('refuses to save when the unreadable value could not even be backed up', () => {
    // Quota is exhausted, so the value cannot be moved aside — writes must stop
    // rather than destroy it.
    // Only the backup write is rejected: rejecting every write would make the
    // assertion vacuous, since the save would fail on quota either way.
    const full = new (class extends MemoryStorage {
      override setItem(key: string, value: string): void {
        if (key.includes(':unreadable')) throw new DOMException('quota', 'QuotaExceededError');
        super.setItem(key, value);
      }
    })();
    full.setItem(PRESETS_KEY, CORRUPT_PRESETS);
    full.setItem(REVIEWS_KEY, CORRUPT_REVIEWS);
    full.setItem(SETTINGS_KEY, CORRUPT_SETTINGS);
    g.localStorage = full;

    buildInitialPresets();
    loadReviews();
    loadSettings();

    const presetResult = savePresets([customPreset]);
    assert.strictEqual(presetResult.ok === false && presetResult.reason, 'unreadable');
    assert.strictEqual(full.getItem(PRESETS_KEY), CORRUPT_PRESETS);

    const reviewResult = saveReviews(new Map<string, ClashReview>([['k', { status: 'resolved' }]]));
    assert.strictEqual(reviewResult.ok === false && reviewResult.reason, 'unreadable');
    assert.strictEqual(full.getItem(REVIEWS_KEY), CORRUPT_REVIEWS);

    const settingsResult = saveSettings({ ...DEFAULT_CLASH_SETTINGS, tolerance: 0.01 });
    assert.strictEqual(settingsResult.ok === false && settingsResult.reason, 'unreadable');
    assert.strictEqual(full.getItem(SETTINGS_KEY), CORRUPT_SETTINGS);
  });
});
