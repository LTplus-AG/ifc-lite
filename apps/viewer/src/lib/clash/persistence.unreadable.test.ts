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
  loadExclusions,
  saveExclusions,
  DEFAULT_CLASH_SETTINGS,
  type ClashPreset,
} from './persistence.js';
import type { ClashExclusionRule } from './exclusions.js';

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
const EXCLUSIONS_KEY = 'ifc-lite-clash-exclusions';

/** Truncated JSON — the shape a half-written or externally mangled entry has. */
const CORRUPT_PRESETS = '{"schemaVersion":1,"presets":[{"id":"custom-1","name":"My rule"';
const CORRUPT_REVIEWS = '{"schemaVersion":1,"reviews":{"rule-a G1 G2":{"status":"resol';
const CORRUPT_SETTINGS = '{"schemaVersion":1,"settings":{"mode":"hard","tolerance":0.5';
const CORRUPT_EXCLUSIONS = '{"schemaVersion":1,"exclusions":[{"id":"excl-1","kind":"typePair"';

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

const customExclusion: ClashExclusionRule = {
  id: 'excl-new',
  kind: 'typePair',
  a: 'IfcPipeSegment',
  b: 'IfcDuctSegment',
  label: 'IfcPipeSegment × IfcDuctSegment',
  enabled: true,
  createdAt: 1_700_000_000_000,
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
    loadExclusions();
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
    loadExclusions();
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

  it('preserves unreadable exclusions across the save that follows the failed read', () => {
    ls.setItem(EXCLUSIONS_KEY, CORRUPT_EXCLUSIONS);

    // The read degrades to empty — the user's stored rules are not visible.
    assert.deepStrictEqual(loadExclusions(), []);

    // ...and the very next edit persists that degraded (empty) list.
    assert.deepStrictEqual(saveExclusions([customExclusion]), { ok: true });

    assert.ok(survives(ls, CORRUPT_EXCLUSIONS), 'the unreadable exclusions blob was destroyed by the save');
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

    // The save reporting `ok: true` is not, on its own, proof that anything was
    // written: read SETTINGS_KEY back and check it actually holds the edit, so a
    // no-op save (or one that silently wrote something else) cannot pass this
    // test the way it could when only the `SaveResult` and `survives()` were
    // checked.
    const persisted = JSON.parse(ls.getItem(SETTINGS_KEY)!) as { settings: typeof DEFAULT_CLASH_SETTINGS };
    assert.strictEqual(persisted.settings.tolerance, 0.01, 'the recovery save did not actually write the new settings');
  });

  // An empty string is not "no entry" — it is the corrupt entry a truncated or
  // interrupted write is most likely to leave behind. `!raw` treats it the same
  // as a missing key (both are falsy), so it must be `raw === null` specifically,
  // or an empty string never reaches `JSON.parse` and silently skips the whole
  // preserve-and-quarantine path this suite otherwise exercises.
  it('treats an empty stored string as a read failure, not "no entry"', () => {
    ls.setItem(SETTINGS_KEY, '');

    const loaded = loadSettings();
    assert.deepStrictEqual(loaded, DEFAULT_CLASH_SETTINGS);

    // The empty string must have gone through the same preserve-and-quarantine
    // path as bad JSON — moved to a backup key — not silently skipped because
    // it happened to also be falsy like a missing key.
    assert.ok(
      ls.store.has(`${SETTINGS_KEY}:unreadable`),
      'an empty stored string must be preserved as an unreadable entry, not treated as if nothing was ever stored',
    );

    // Ordinary recovery, not a lockout: the very next save still succeeds and
    // actually writes, since the empty value was successfully backed up.
    assert.deepStrictEqual(saveSettings({ ...DEFAULT_CLASH_SETTINGS, tolerance: 0.01 }), { ok: true });
    const persisted = JSON.parse(ls.getItem(SETTINGS_KEY)!) as { settings: typeof DEFAULT_CLASH_SETTINGS };
    assert.strictEqual(persisted.settings.tolerance, 0.01);
  });

  // The presets and reviews loaders guard the same `raw === null` distinction
  // as settings (see the comment above) — pinned here so the three loaders
  // that share the guard stay provably in sync, not just settings.
  it('treats an empty stored string as a read failure for presets, not "no entry"', () => {
    ls.setItem(PRESETS_KEY, '');

    const presets = buildInitialPresets();
    assert.ok(presets.every((p) => p.builtin), 'expected only built-ins after a failed read');
    assert.ok(
      ls.store.has(`${PRESETS_KEY}:unreadable`),
      'an empty stored string must be preserved as an unreadable entry, not treated as if nothing was ever stored',
    );

    assert.deepStrictEqual(savePresets([...presets, customPreset]), { ok: true });
    assert.deepStrictEqual(
      buildInitialPresets().filter((p) => !p.builtin).map((p) => p.id),
      ['custom-new'],
    );
  });

  it('treats an empty stored string as a read failure for reviews, not "no entry"', () => {
    ls.setItem(REVIEWS_KEY, '');

    assert.strictEqual(loadReviews().size, 0);
    assert.ok(
      ls.store.has(`${REVIEWS_KEY}:unreadable`),
      'an empty stored string must be preserved as an unreadable entry, not treated as if nothing was ever stored',
    );

    const map = new Map<string, ClashReview>([['k', { status: 'resolved' }]]);
    assert.deepStrictEqual(saveReviews(map), { ok: true });
    assert.strictEqual(loadReviews().get('k')?.status, 'resolved');
  });

  // UNLIKE its three siblings, `loadExclusions` guards on `if (!raw)` rather
  // than `if (raw === null)` (persistence.ts, `loadExclusions`) — so an empty
  // stored string is indistinguishable from a genuinely absent key: it is
  // treated as "no entry", never backed up, and never latches the key
  // unwritable. This test pins that ACTUAL (divergent) behavior rather than
  // forcing the symmetry the other three loaders have; whether that divergence
  // is intentional is a question for whoever owns `loadExclusions`, not
  // something this suite should paper over.
  it('an empty stored string for exclusions is treated as "no entry", unlike its three siblings', () => {
    ls.setItem(EXCLUSIONS_KEY, '');

    const loaded = loadExclusions();
    assert.deepStrictEqual(loaded, []);
    assert.ok(
      !ls.store.has(`${EXCLUSIONS_KEY}:unreadable`),
      'loadExclusions currently does NOT preserve an empty string as unreadable — unlike presets/reviews/settings',
    );

    // Because the key was never latched, a save right after goes through
    // normally (there is nothing to protect: the "corrupt" bytes were empty).
    assert.deepStrictEqual(saveExclusions([customExclusion]), { ok: true });
  });

  // Bounding control: a genuinely absent key is not a read failure. Without
  // this, a fix that widens the check too far (e.g. treating `undefined` or
  // any falsy `raw` as corrupt) would misclassify a brand-new user's first run
  // as data corruption.
  it('a genuinely absent key still returns defaults without being treated as corrupt', () => {
    // Nothing was ever set at SETTINGS_KEY (beforeEach starts from a fresh store).
    assert.strictEqual(ls.getItem(SETTINGS_KEY), null);

    const loaded = loadSettings();
    assert.deepStrictEqual(loaded, DEFAULT_CLASH_SETTINGS);
    assert.ok(!ls.store.has(`${SETTINGS_KEY}:unreadable`), 'a missing key must not be preserved as an unreadable entry');

    assert.deepStrictEqual(saveSettings({ ...DEFAULT_CLASH_SETTINGS, tolerance: 0.03 }), { ok: true });
    const persisted = JSON.parse(ls.getItem(SETTINGS_KEY)!) as { settings: typeof DEFAULT_CLASH_SETTINGS };
    assert.strictEqual(persisted.settings.tolerance, 0.03);
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

  it('keeps saving exclusions after an unreadable read, and honours a clearing edit', () => {
    ls.setItem(EXCLUSIONS_KEY, CORRUPT_EXCLUSIONS);
    loadExclusions();

    saveExclusions([customExclusion]);
    assert.deepStrictEqual(loadExclusions().map((r) => r.id), ['excl-new']);

    saveExclusions([]);
    assert.deepStrictEqual(loadExclusions(), []);
    assert.ok(survives(ls, CORRUPT_EXCLUSIONS));
  });

  // The doc comment on `unwritableKeys` (persistence.ts) promises entries are
  // "cleared by a later clean read" — pinned directly here rather than only
  // relying on the cross-file proof the `after` hook above describes (every
  // other test file in this one `tsx --test` process would otherwise start
  // latched too). Confirmed by mutation: deleting any one loader's
  // `unwritableKeys.delete(...)` guard killed nothing in this suite until
  // these four tests existed — each is the ONLY thing pinning its loader's
  // guard.
  it('a later clean read clears the presets latch', () => {
    const full = new (class extends MemoryStorage {
      override setItem(key: string, value: string): void {
        if (key.includes(':unreadable')) throw new DOMException('quota', 'QuotaExceededError');
        super.setItem(key, value);
      }
    })();
    full.setItem(PRESETS_KEY, CORRUPT_PRESETS);
    g.localStorage = full;
    buildInitialPresets();

    const blocked = savePresets([customPreset]);
    assert.strictEqual(blocked.ok === false && blocked.reason, 'unreadable');

    g.localStorage = new MemoryStorage();
    buildInitialPresets();
    assert.deepStrictEqual(savePresets([customPreset]), { ok: true });
  });

  it('a later clean read clears the reviews latch', () => {
    const full = new (class extends MemoryStorage {
      override setItem(key: string, value: string): void {
        if (key.includes(':unreadable')) throw new DOMException('quota', 'QuotaExceededError');
        super.setItem(key, value);
      }
    })();
    full.setItem(REVIEWS_KEY, CORRUPT_REVIEWS);
    g.localStorage = full;
    loadReviews();

    const blocked = saveReviews(new Map<string, ClashReview>([['k', { status: 'resolved' }]]));
    assert.strictEqual(blocked.ok === false && blocked.reason, 'unreadable');

    g.localStorage = new MemoryStorage();
    loadReviews();
    assert.deepStrictEqual(saveReviews(new Map<string, ClashReview>([['k', { status: 'resolved' }]])), { ok: true });
  });

  it('a later clean read clears the settings latch', () => {
    const full = new (class extends MemoryStorage {
      override setItem(key: string, value: string): void {
        if (key.includes(':unreadable')) throw new DOMException('quota', 'QuotaExceededError');
        super.setItem(key, value);
      }
    })();
    full.setItem(SETTINGS_KEY, CORRUPT_SETTINGS);
    g.localStorage = full;
    loadSettings();

    const blocked = saveSettings({ ...DEFAULT_CLASH_SETTINGS, tolerance: 0.01 });
    assert.strictEqual(blocked.ok === false && blocked.reason, 'unreadable');

    g.localStorage = new MemoryStorage();
    loadSettings();
    assert.deepStrictEqual(saveSettings({ ...DEFAULT_CLASH_SETTINGS, tolerance: 0.01 }), { ok: true });
  });

  it('a later clean read clears the exclusions latch', () => {
    const full = new (class extends MemoryStorage {
      override setItem(key: string, value: string): void {
        if (key.includes(':unreadable')) throw new DOMException('quota', 'QuotaExceededError');
        super.setItem(key, value);
      }
    })();
    full.setItem(EXCLUSIONS_KEY, CORRUPT_EXCLUSIONS);
    g.localStorage = full;
    loadExclusions();

    // Latched: the backup write failed, so a save must refuse.
    const blocked = saveExclusions([customExclusion]);
    assert.strictEqual(blocked.ok === false && blocked.reason, 'unreadable');

    // A later clean read (ordinary storage, no corrupt entry) must clear the
    // latch — the guard this whole suite is named for.
    g.localStorage = new MemoryStorage();
    loadExclusions();
    assert.deepStrictEqual(saveExclusions([customExclusion]), { ok: true });
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
    full.setItem(EXCLUSIONS_KEY, CORRUPT_EXCLUSIONS);
    g.localStorage = full;

    buildInitialPresets();
    loadReviews();
    loadSettings();
    loadExclusions();

    const presetResult = savePresets([customPreset]);
    assert.strictEqual(presetResult.ok === false && presetResult.reason, 'unreadable');
    assert.strictEqual(full.getItem(PRESETS_KEY), CORRUPT_PRESETS);

    const reviewResult = saveReviews(new Map<string, ClashReview>([['k', { status: 'resolved' }]]));
    assert.strictEqual(reviewResult.ok === false && reviewResult.reason, 'unreadable');
    assert.strictEqual(full.getItem(REVIEWS_KEY), CORRUPT_REVIEWS);

    const settingsResult = saveSettings({ ...DEFAULT_CLASH_SETTINGS, tolerance: 0.01 });
    assert.strictEqual(settingsResult.ok === false && settingsResult.reason, 'unreadable');
    assert.strictEqual(full.getItem(SETTINGS_KEY), CORRUPT_SETTINGS);

    const exclusionsResult = saveExclusions([customExclusion]);
    assert.strictEqual(exclusionsResult.ok === false && exclusionsResult.reason, 'unreadable');
    assert.strictEqual(full.getItem(EXCLUSIONS_KEY), CORRUPT_EXCLUSIONS);
  });
});
