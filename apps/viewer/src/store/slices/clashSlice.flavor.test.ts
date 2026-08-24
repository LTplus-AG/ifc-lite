/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Activating a flavor must only show the flavor's clash config once it is
 * actually stored.
 *
 * `applyClashFlavorConfig` used to `set(...)` first and then discard both
 * `savePresets` and `saveSettings` results, so with storage refusing a write
 * (quota, or storage blocked entirely) the panel showed the flavor's rule set
 * and tolerances as active and the previous flavor's came back on reload.
 *
 * It writes TWO independent localStorage keys, so these also pin the partial
 * case in both directions: presets land / settings refused (the landed half is
 * rolled back and nothing is committed), and presets refused (settings are
 * never attempted).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createClashSlice, type ClashSlice } from './clashSlice.js';
import { deserializeClashConfig } from '@/lib/clash/persistence';
import type { ClashPreset, ClashGlobalSettings } from '@/lib/clash/persistence';

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
  /**
   * Once this many writes have landed, EVERY subsequent `setItem` throws,
   * regardless of key — genuine quota exhaustion (the disk is full), as
   * opposed to `failKey`'s "this one key is blocked". A rollback write is a
   * write like any other, so this is what makes a failed rollback reachable:
   * `failKey` alone can never fail a write to a *different* key.
   */
  failAfterWrites: number | null = null;
  /** Every successful write, in order (lets a test prove nothing was persisted). */
  writes: string[] = [];
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (key === this.failKey) throw new DOMException('quota', 'QuotaExceededError');
    if (this.failAfterWrites !== null && this.writes.length >= this.failAfterWrites) {
      throw new DOMException('quota', 'QuotaExceededError');
    }
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

const OLD_CUSTOM_ID = 'custom-before-switch';
const FLAVOR_CUSTOM_ID = 'custom-from-flavor';

/** What the previously active flavor left in storage. */
const OLD_SETTINGS: ClashGlobalSettings = {
  mode: 'hard',
  tolerance: 0.002,
  clearance: 0.05,
  duplicateTolerance: 0.01,
  clusterEpsilon: 1.5,
  reportTouch: false,
  groupBy: 'severity',
};

/** What the flavor being activated carries — every field differs from OLD. */
const FLAVOR_SETTINGS: ClashGlobalSettings = {
  mode: 'clearance',
  tolerance: 0.02,
  clearance: 0.25,
  duplicateTolerance: 0.05,
  clusterEpsilon: 3,
  reportTouch: true,
  groupBy: 'rule',
};

function customPreset(id: string, name: string): ClashPreset {
  return {
    id,
    name,
    description: '',
    severity: 'major',
    selectorA: 'IfcWall',
    selectorB: 'IfcDoor',
    enabled: true,
    builtin: false,
  };
}

const FLAVOR_PRESETS: ClashPreset[] = [customPreset(FLAVOR_CUSTOM_ID, 'Flavor rule')];

/** Ids of the custom rules currently written under the presets key. */
function storedCustomIds(storage: MemoryStorage): string[] {
  const raw = storage.getItem(PRESETS_KEY);
  if (!raw) return [];
  return (JSON.parse(raw) as { presets: ClashPreset[] }).presets.map((p) => p.id);
}

/** Tolerance currently written under the settings key (null if absent). */
function storedTolerance(storage: MemoryStorage): number | null {
  const raw = storage.getItem(SETTINGS_KEY);
  if (!raw) return null;
  return (JSON.parse(raw) as { settings: ClashGlobalSettings }).settings.tolerance;
}

describe('applyClashFlavorConfig - only commit a config that actually persisted', () => {
  let storage: MemoryStorage;
  let state: ClashSlice;

  beforeEach(() => {
    storage = new MemoryStorage();
    g.localStorage = storage;
    // Seed the state the previous flavor left behind, through the real writers'
    // own format, so the slice loads it on construction.
    storage.setItem(
      PRESETS_KEY,
      JSON.stringify({
        schemaVersion: 1,
        presets: [customPreset(OLD_CUSTOM_ID, 'Rule from the previous flavor')],
      }),
    );
    storage.setItem(SETTINGS_KEY, JSON.stringify({ schemaVersion: 1, settings: OLD_SETTINGS }));
    storage.writes.length = 0; // the seed is setup, not a write under test

    const setState = (
      partial: Partial<ClashSlice> | ((s: ClashSlice) => Partial<ClashSlice>),
    ) => {
      state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    };
    state = createClashSlice(setState, () => state, {} as never);
  });

  it('the stub is selective and the slice really loaded the seeded config', () => {
    storage.failKey = SETTINGS_KEY;
    assert.throws(() => storage.setItem(SETTINGS_KEY, 'x'));
    storage.setItem(PRESETS_KEY, 'y'); // every other key still writes
    assert.strictEqual(storage.getItem(PRESETS_KEY), 'y'); // ...and reads back
    // The slice went through the real load path, not a default.
    assert.ok(state.clashPresets.some((p) => p.id === OLD_CUSTOM_ID));
    assert.strictEqual(state.clashTolerance, OLD_SETTINGS.tolerance);
  });

  // ── partial: presets land, settings refused ────────────────────────────────

  it('rolls back and commits nothing when the settings write is refused', () => {
    storage.failKey = SETTINGS_KEY;

    const result = state.applyClashFlavorConfig({
      presets: FLAVOR_PRESETS,
      settings: FLAVOR_SETTINGS,
    });

    assert.strictEqual(result.ok, false, 'a refused settings write must be reported');
    assert.ok(!result.ok && result.message.length > 0);

    // Nothing committed: neither half of the flavor's config shows as applied.
    assert.ok(
      state.clashPresets.some((p) => p.id === OLD_CUSTOM_ID),
      'the previous flavor rule set must still be listed',
    );
    assert.ok(!state.clashPresets.some((p) => p.id === FLAVOR_CUSTOM_ID));
    assert.strictEqual(state.clashTolerance, OLD_SETTINGS.tolerance);
    assert.strictEqual(state.clashDuplicateTolerance, OLD_SETTINGS.duplicateTolerance);
    assert.strictEqual(state.clashMode, OLD_SETTINGS.mode);
    assert.strictEqual(state.clashGroupBy, OLD_SETTINGS.groupBy);

    // ...and the half that DID land was undone, so storage agrees with the store.
    assert.deepStrictEqual(storedCustomIds(storage), [OLD_CUSTOM_ID]);
    assert.strictEqual(storedTolerance(storage), OLD_SETTINGS.tolerance);
    assert.deepStrictEqual(
      storage.writes,
      [PRESETS_KEY, PRESETS_KEY],
      'the presets write and its rollback, and no settings write',
    );
  });

  // ── genuine quota exhaustion: the rollback itself also fails ───────────────

  it('reports the mismatch when the rollback also fails, and never claims the flavor applied', () => {
    // The presets write is the very first write attempted here (the seed above
    // resets `writes` to empty), so allowing exactly one write lets it land and
    // then fails everything after — the settings write AND the rollback's
    // presets write. A single blocked key (`failKey`) cannot reach this: the
    // rollback writes to the SAME key that just succeeded, so a per-key stub
    // would let it through and hide this exact defect.
    storage.failAfterWrites = 1;

    const result = state.applyClashFlavorConfig({
      presets: FLAVOR_PRESETS,
      settings: FLAVOR_SETTINGS,
    });

    assert.strictEqual(result.ok, false, 'a refused settings write must be reported');
    assert.ok(
      !result.ok && /previous rule set could also not be restored/.test(result.message),
      'the message must name the rollback failure, not read like an ordinary settings refusal',
    );

    // What the user sees: the store never moved off the previous flavor.
    assert.ok(
      state.clashPresets.some((p) => p.id === OLD_CUSTOM_ID),
      'the previous flavor rule set must still be listed',
    );
    assert.ok(!state.clashPresets.some((p) => p.id === FLAVOR_CUSTOM_ID));
    assert.strictEqual(state.clashTolerance, OLD_SETTINGS.tolerance);

    // What is actually on disk: the hybrid the user never chose. This is the
    // residual defect — the store is correct, but storage now holds the NEW
    // presets next to the OLD settings, and that mismatched pair is exactly
    // what a reload would rehydrate.
    assert.deepStrictEqual(
      storedCustomIds(storage),
      [FLAVOR_CUSTOM_ID],
      'the presets write landed and the rollback could not undo it',
    );
    assert.strictEqual(
      storedTolerance(storage),
      OLD_SETTINGS.tolerance,
      'the settings write never landed at all',
    );
    assert.deepStrictEqual(
      storage.writes,
      [PRESETS_KEY],
      'only the original presets write landed; the settings write and the rollback both threw',
    );
  });

  /**
   * The two outcomes above differ in a way that matters to a caller: after the
   * first, storage is consistent (the rollback undid the landed half); after
   * the second, storage holds the NEW rule set beside the OLD settings. Both
   * are reported with `ok: false`, so `reason` is the only field a caller can
   * branch on — a `message` is display text, not a contract. Reusing the
   * settings write's own `reason` for the double failure makes "recovered" and
   * "storage is now inconsistent" the same value, and genuine quota exhaustion
   * (the case that produces the second) reports `'quota'` for both.
   */
  it('distinguishes a recovered rollback from a failed one in the machine-readable reason', () => {
    // Scenario A: only the settings key is blocked, so the rollback's write to
    // the presets key lands and storage ends up consistent.
    storage.failKey = SETTINGS_KEY;
    const recovered = state.applyClashFlavorConfig({
      presets: FLAVOR_PRESETS,
      settings: FLAVOR_SETTINGS,
    });
    assert.strictEqual(recovered.ok, false);
    // Pin the premise: this really is the consistent outcome.
    assert.deepStrictEqual(storedCustomIds(storage), [OLD_CUSTOM_ID]);
    // Pin this half too: "not the stranded reason" would also hold if the
    // recovered case started reporting some third value, which would be its
    // own lie. It is an ordinary refused settings write and says so.
    assert.strictEqual(
      !recovered.ok && recovered.reason,
      'quota',
      'a recovered rollback is just a refused settings write: it carries that write reason',
    );

    // Scenario B: the disk is full, so the settings write AND the rollback both
    // throw and storage is left holding the hybrid. Rebuild from scratch so
    // this apply starts from the same seeded state scenario A did.
    storage = new MemoryStorage();
    g.localStorage = storage;
    storage.setItem(
      PRESETS_KEY,
      JSON.stringify({
        schemaVersion: 1,
        presets: [customPreset(OLD_CUSTOM_ID, 'Rule from the previous flavor')],
      }),
    );
    storage.setItem(SETTINGS_KEY, JSON.stringify({ schemaVersion: 1, settings: OLD_SETTINGS }));
    storage.writes.length = 0;
    const setState = (
      partial: Partial<ClashSlice> | ((s: ClashSlice) => Partial<ClashSlice>),
    ) => {
      state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    };
    state = createClashSlice(setState, () => state, {} as never);
    storage.failAfterWrites = 1;

    const stranded = state.applyClashFlavorConfig({
      presets: FLAVOR_PRESETS,
      settings: FLAVOR_SETTINGS,
    });
    assert.strictEqual(stranded.ok, false);
    // Pin the premise: this really is the inconsistent outcome.
    assert.deepStrictEqual(storedCustomIds(storage), [FLAVOR_CUSTOM_ID]);
    assert.strictEqual(storedTolerance(storage), OLD_SETTINGS.tolerance);

    assert.notStrictEqual(
      !stranded.ok && stranded.reason,
      !recovered.ok && recovered.reason,
      'a caller must be able to tell a stranded write from a recovered one without parsing the message',
    );
    assert.strictEqual(
      !stranded.ok && stranded.reason,
      'rollback_failed',
      'the double failure needs its own reason, not the settings write reason',
    );
    // The human-readable half is unchanged: this adds a signal, it does not
    // replace the enriched message the console warning relies on.
    assert.ok(
      !stranded.ok && /previous rule set could also not be restored/.test(stranded.message),
    );
  });

  /**
   * ...and the mirror of that: `rollback_failed` must not be raised when
   * storage is provably intact.
   *
   * A flavor can carry a rule set that serializes to exactly what is already
   * stored while differing only in its tolerances — flavors that share a rule
   * set and tune the thresholds around it. Then the "presets write" that lands
   * rewrites the same bytes, so when the settings write and the rollback both
   * fail there is nothing stranded: both keys still hold what they held before
   * the apply. Inferring inconsistency from the undo write throwing, without
   * asking whether the first write changed anything, reports the strongest
   * "saved data may no longer match" signal over untouched storage.
   */
  it('does not claim a failed rollback stranded anything when the rule set never changed', () => {
    // The rule set the flavor carries is the one already in storage; only the
    // settings differ. `savePresets` will rewrite byte-for-byte what is there.
    const sameRuleSet = [customPreset(OLD_CUSTOM_ID, 'Rule from the previous flavor')];
    const presetsBefore = storage.getItem(PRESETS_KEY);
    const settingsBefore = storage.getItem(SETTINGS_KEY);

    // Genuine quota exhaustion: the presets write lands, then the settings
    // write and the rollback's presets write both throw.
    storage.failAfterWrites = 1;

    const result = state.applyClashFlavorConfig({
      presets: sameRuleSet,
      settings: FLAVOR_SETTINGS,
    });

    assert.strictEqual(result.ok, false, 'the settings write was still refused');
    // Pin the premise on BOTH keys: storage is byte-identical to before the
    // apply, so there is no hybrid to warn about. Comparing raw bytes, not
    // parsed shapes, because bytes are what a reload rehydrates.
    assert.strictEqual(
      storage.getItem(PRESETS_KEY),
      presetsBefore,
      'the rule set on disk must be untouched — the write that landed rewrote it identically',
    );
    assert.strictEqual(
      storage.getItem(SETTINGS_KEY),
      settingsBefore,
      'the settings write never landed, so that key must be untouched too',
    );
    // ...and the store never moved either.
    assert.ok(state.clashPresets.some((p) => p.id === OLD_CUSTOM_ID));
    assert.strictEqual(state.clashTolerance, OLD_SETTINGS.tolerance);

    assert.notStrictEqual(
      !result.ok && result.reason,
      'rollback_failed',
      'storage is intact on both keys, so the "storage may be inconsistent" reason is a lie',
    );
    assert.strictEqual(
      !result.ok && result.reason,
      'quota',
      'this is an ordinary refused settings write: the reason is the settings write reason',
    );
  });

  /**
   * The same no-op rule, applied to the presets key's own legacy shape.
   *
   * `readStoredPresets` accepts a bare array as well as the versioned wrapper,
   * so the store can be in sync with a stored value that is NOT the bytes
   * `savePresets` writes. Then a presets write that `presetsStoreIdentically`
   * calls a no-op does change the key's bytes (`[...]` becomes
   * `{"schemaVersion":1,"presets":[...]}`) — which is why that helper documents
   * the store's serialized form, not the bytes on disk.
   *
   * The verdict is still `'quota'` and not `'rollback_failed'`: what the
   * upgrade rewrote is the same rule set in the current format, so the pair of
   * keys left behind rehydrates to exactly the store the user is left looking
   * at. Nothing was stranded.
   */
  it('treats a legacy bare-array upgrade as a no-op presets write when the rollback fails', () => {
    // Re-seed the presets key in the pre-wrapper format and rebuild the slice
    // from it, so the store really was loaded through the legacy branch.
    storage = new MemoryStorage();
    g.localStorage = storage;
    storage.setItem(
      PRESETS_KEY,
      JSON.stringify([customPreset(OLD_CUSTOM_ID, 'Rule from the previous flavor')]),
    );
    storage.setItem(SETTINGS_KEY, JSON.stringify({ schemaVersion: 1, settings: OLD_SETTINGS }));
    storage.writes.length = 0;
    const setState = (
      partial: Partial<ClashSlice> | ((s: ClashSlice) => Partial<ClashSlice>),
    ) => {
      state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    };
    state = createClashSlice(setState, () => state, {} as never);
    assert.ok(
      state.clashPresets.some((p) => p.id === OLD_CUSTOM_ID),
      'premise: the legacy bare array really was loaded',
    );

    const legacyBytes = storage.getItem(PRESETS_KEY);
    assert.ok(legacyBytes?.startsWith('['), 'premise: the stored value is the bare-array shape');

    // The flavor carries the rule set already in the store; only settings move.
    const sameRuleSet = [customPreset(OLD_CUSTOM_ID, 'Rule from the previous flavor')];
    storage.failAfterWrites = 1; // presets land, settings write and rollback throw

    const result = state.applyClashFlavorConfig({
      presets: sameRuleSet,
      settings: FLAVOR_SETTINGS,
    });

    assert.strictEqual(result.ok, false, 'the settings write was still refused');
    // The bytes DID change — the wrapper replaced the bare array — so this is
    // the case the "no-op on disk" wording could not describe.
    assert.notStrictEqual(
      storage.getItem(PRESETS_KEY),
      legacyBytes,
      'the write that landed rewrote the legacy shape into the wrapper',
    );
    // ...and what those new bytes mean is unchanged: reloading gives the same
    // rule set the store still holds, beside the untouched settings.
    assert.deepStrictEqual(storedCustomIds(storage), [OLD_CUSTOM_ID]);
    assert.strictEqual(storedTolerance(storage), OLD_SETTINGS.tolerance);
    assert.ok(state.clashPresets.some((p) => p.id === OLD_CUSTOM_ID));
    assert.strictEqual(state.clashTolerance, OLD_SETTINGS.tolerance);

    assert.strictEqual(
      !result.ok && result.reason,
      'quota',
      'nothing was stranded: the format upgrade stores the rule set the store still shows',
    );
  });

  // ── the settings write is refused but the bytes are already stored ─────────

  /**
   * The mirror of the presets rule, on the settings key.
   *
   * A flavor can carry the settings that are already stored and differ only in
   * its rule set — flavors that share the detection thresholds and swap the
   * rules around them. Aborting on `!settingsResult.ok` unconditionally then
   * rolls back a presets write that was fine and reports "clash settings were
   * not saved" over storage that holds exactly those settings.
   */
  it('applies the flavor when the refused settings write would not have changed the stored bytes', () => {
    storage.failKey = SETTINGS_KEY;
    const settingsBefore = storage.getItem(SETTINGS_KEY);

    // A distinct object carrying the settings already on disk: the flavor moves
    // the rule set only.
    const result = state.applyClashFlavorConfig({
      presets: FLAVOR_PRESETS,
      settings: { ...OLD_SETTINGS },
    });

    assert.deepStrictEqual(
      result,
      { ok: true },
      'the refused write would have rewritten the bytes already stored, so it changed nothing',
    );
    // The flavor is live in the store...
    assert.deepStrictEqual(state.clashPresets.map((p) => p.id), [FLAVOR_CUSTOM_ID]);
    assert.strictEqual(state.clashTolerance, OLD_SETTINGS.tolerance);
    // ...and storage matches it on both keys: the new rule set landed and the
    // settings key still holds the very bytes the flavor asked for.
    assert.deepStrictEqual(storedCustomIds(storage), [FLAVOR_CUSTOM_ID]);
    assert.strictEqual(
      storage.getItem(SETTINGS_KEY),
      settingsBefore,
      'the settings key was never written — it did not need to be',
    );
    assert.strictEqual(storedTolerance(storage), OLD_SETTINGS.tolerance);
    assert.deepStrictEqual(
      storage.writes,
      [PRESETS_KEY],
      'the presets write landed and was not rolled back',
    );
  });

  it('applies it under genuine quota exhaustion too, without attempting a rollback', () => {
    // The other side of the same cell: not one blocked key but a full disk, so
    // the settings write and any rollback would both throw. The presets write
    // lands first and nothing after it can, which is exactly why the apply must
    // not depend on a write it does not need.
    storage.failAfterWrites = 1;
    const settingsBefore = storage.getItem(SETTINGS_KEY);

    const result = state.applyClashFlavorConfig({
      presets: FLAVOR_PRESETS,
      settings: { ...OLD_SETTINGS },
    });

    assert.deepStrictEqual(result, { ok: true });
    assert.deepStrictEqual(state.clashPresets.map((p) => p.id), [FLAVOR_CUSTOM_ID]);
    assert.deepStrictEqual(storedCustomIds(storage), [FLAVOR_CUSTOM_ID]);
    assert.strictEqual(storage.getItem(SETTINGS_KEY), settingsBefore);
    assert.deepStrictEqual(
      storage.writes,
      [PRESETS_KEY],
      'no rollback was attempted: there was nothing to undo',
    );
  });

  it('still fails, and rolls back, when the refused settings differ by a single field', () => {
    storage.failKey = SETTINGS_KEY;

    const result = state.applyClashFlavorConfig({
      presets: FLAVOR_PRESETS,
      // Everything the case above has, except one field the user would notice.
      settings: { ...OLD_SETTINGS, reportTouch: !OLD_SETTINGS.reportTouch },
    });

    assert.strictEqual(result.ok, false, 'this write really would have changed the stored settings');
    assert.strictEqual(!result.ok && result.reason, 'quota');
    assert.ok(!state.clashPresets.some((p) => p.id === FLAVOR_CUSTOM_ID));
    assert.strictEqual(state.clashReportTouch, OLD_SETTINGS.reportTouch);
    assert.deepStrictEqual(storedCustomIds(storage), [OLD_CUSTOM_ID], 'the presets write was undone');
  });

  /**
   * The no-op settings rule with BOTH sides built the way production builds
   * them, rather than one spread from the other.
   *
   * The comparison is between bytes `snapshotSettings` (this file's slice) put
   * on disk and a settings object `normalizeSettings` built (what
   * `deserializeClashConfig` hands `applyClashFlavorConfig` from a flavor's
   * blob — see `ExtensionHostService`). Those are two unshared object literals
   * in two files, and every other test of this branch feeds the equal case a
   * spread of the seed, which inherits the seed's key order and so cannot
   * observe a divergence between the two producers at all.
   *
   * So: drive the stored bytes through the slice's own setters (the real
   * writer), then build the flavor's half through the real deserializer, and
   * let them meet. Nothing here shares an object with anything there.
   */
  it('treats settings the deserializer built as already stored when the slice wrote them', () => {
    // The real writer: each setter snapshots the slice and persists it.
    state.setClashMode('clearance');
    state.setClashTolerance(0.007);
    state.setClashClearance(0.11);
    state.setClashDuplicateTolerance(0.023);
    state.setClashClusterEpsilon(2.5);
    state.setClashReportTouch(true);
    state.setClashGroupBy('rule');
    const settingsBefore = storage.getItem(SETTINGS_KEY);
    assert.ok(settingsBefore?.includes('0.007'), 'premise: the slice really persisted its snapshot');
    storage.writes.length = 0;

    // The real reader: a flavor blob through the deserializer, whose settings
    // object is built by `normalizeSettings` — the other production literal.
    const config = deserializeClashConfig({
      presets: [customPreset(FLAVOR_CUSTOM_ID, 'Flavor rule')],
      settings: {
        mode: 'clearance',
        tolerance: 0.007,
        clearance: 0.11,
        duplicateTolerance: 0.023,
        clusterEpsilon: 2.5,
        reportTouch: true,
        groupBy: 'rule',
      },
    });
    assert.ok(config, 'premise: the blob deserialized');

    storage.failKey = SETTINGS_KEY;
    const result = state.applyClashFlavorConfig(config);

    assert.deepStrictEqual(
      result,
      { ok: true },
      'the two producers describe the same settings, so the refused write would have changed nothing',
    );
    assert.deepStrictEqual(state.clashPresets.filter((p) => !p.builtin).map((p) => p.id), [FLAVOR_CUSTOM_ID]);
    assert.deepStrictEqual(storedCustomIds(storage), [FLAVOR_CUSTOM_ID]);
    assert.strictEqual(storage.getItem(SETTINGS_KEY), settingsBefore, 'the settings key never moved');
    assert.deepStrictEqual(storage.writes, [PRESETS_KEY]);
  });

  // ── the presets write is refused but the rule set is already stored ───────

  /**
   * The same no-op rule as the two cases above, on the write that runs FIRST.
   *
   * "Nothing written, nothing to undo" is a statement about the rollback, not a
   * reason to fail: a flavor can carry the rule set that is already stored and
   * move only the thresholds — the exact twin of the settings-side case, and
   * the pairing the rollback branch already names as realistic. With the
   * presets key blocked, the refused write would have stored what is stored
   * already, so the settings write below it can still land and the flavor is
   * fully applied. Aborting instead applies nothing and tells the user the
   * clash rules were not saved over storage holding exactly those rules.
   */
  it('applies the flavor when the refused presets write would not have changed the stored rule set', () => {
    storage.failKey = PRESETS_KEY;
    const presetsBefore = storage.getItem(PRESETS_KEY);

    // The flavor carries the rule set already in storage; only settings move.
    const result = state.applyClashFlavorConfig({
      presets: [customPreset(OLD_CUSTOM_ID, 'Rule from the previous flavor')],
      settings: FLAVOR_SETTINGS,
    });

    assert.deepStrictEqual(
      result,
      { ok: true },
      'the refused write would have stored the rule set already stored, so it changed nothing',
    );
    // The half that had somewhere to go is live in the store...
    assert.strictEqual(state.clashMode, FLAVOR_SETTINGS.mode);
    assert.strictEqual(state.clashTolerance, FLAVOR_SETTINGS.tolerance);
    assert.strictEqual(state.clashGroupBy, FLAVOR_SETTINGS.groupBy);
    // ...and landed on disk.
    assert.strictEqual(storedTolerance(storage), FLAVOR_SETTINGS.tolerance);
    // The rule set the store shows is the flavor's, which is the one the
    // untouched presets key already holds.
    assert.deepStrictEqual(state.clashPresets.filter((p) => !p.builtin).map((p) => p.id), [OLD_CUSTOM_ID]);
    assert.strictEqual(
      storage.getItem(PRESETS_KEY),
      presetsBefore,
      'the presets key was never written — it did not need to be',
    );
    assert.deepStrictEqual(storedCustomIds(storage), [OLD_CUSTOM_ID]);
    assert.deepStrictEqual(
      storage.writes,
      [SETTINGS_KEY],
      'the settings write is the only one that had anything to do',
    );
  });

  it('still reports the settings refusal when the no-op presets write is followed by a real one', () => {
    // The cell where letting the presets write pass must NOT turn into a
    // success: the rule set is already stored, but the settings write is a
    // real one and it is refused. Nothing the user asked for was applied, so
    // this has to stay a failure — the pass-through above only removes a
    // reason to fail, it does not add a reason to succeed.
    storage.failKey = PRESETS_KEY;
    storage.failAfterWrites = 0; // ...and the settings key cannot be written either
    const presetsBefore = storage.getItem(PRESETS_KEY);
    const settingsBefore = storage.getItem(SETTINGS_KEY);

    const result = state.applyClashFlavorConfig({
      presets: [customPreset(OLD_CUSTOM_ID, 'Rule from the previous flavor')],
      settings: FLAVOR_SETTINGS,
    });

    assert.strictEqual(result.ok, false, 'the settings the flavor asked for were not saved');
    assert.strictEqual(
      !result.ok && result.reason,
      'quota',
      'nothing was stranded: neither key moved, so this is an ordinary refused write',
    );
    // Nothing committed, nothing written.
    assert.strictEqual(state.clashTolerance, OLD_SETTINGS.tolerance);
    assert.strictEqual(state.clashMode, OLD_SETTINGS.mode);
    assert.strictEqual(storage.getItem(PRESETS_KEY), presetsBefore);
    assert.strictEqual(storage.getItem(SETTINGS_KEY), settingsBefore);
    assert.deepStrictEqual(storage.writes, []);
  });

  // ── partial: presets refused ───────────────────────────────────────────────

  it('commits nothing and never touches settings when the presets write is refused', () => {
    storage.failKey = PRESETS_KEY;

    const result = state.applyClashFlavorConfig({
      presets: FLAVOR_PRESETS,
      settings: FLAVOR_SETTINGS,
    });

    assert.strictEqual(result.ok, false);
    assert.ok(state.clashPresets.some((p) => p.id === OLD_CUSTOM_ID));
    assert.strictEqual(state.clashTolerance, OLD_SETTINGS.tolerance);
    assert.deepStrictEqual(storedCustomIds(storage), [OLD_CUSTOM_ID]);
    assert.strictEqual(
      storedTolerance(storage),
      OLD_SETTINGS.tolerance,
      'settings must not move when the rule set could not be stored',
    );
    assert.deepStrictEqual(storage.writes, [], 'nothing was persisted at all');
  });

  it('rejects an over-cap rule set before writing either key', () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => customPreset(`custom-${i}`, `Rule ${i}`));

    const result = state.applyClashFlavorConfig({ presets: tooMany, settings: FLAVOR_SETTINGS });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(!result.ok && result.reason, 'too_many');
    assert.deepStrictEqual(storage.writes, []);
    assert.strictEqual(state.clashTolerance, OLD_SETTINGS.tolerance);
    assert.ok(state.clashPresets.some((p) => p.id === OLD_CUSTOM_ID));
  });

  // ── the happy path still applies ───────────────────────────────────────────

  it('commits both halves and reports ok when storage accepts the writes', () => {
    const result = state.applyClashFlavorConfig({
      presets: FLAVOR_PRESETS,
      settings: FLAVOR_SETTINGS,
    });

    assert.deepStrictEqual(result, { ok: true });
    assert.deepStrictEqual(
      state.clashPresets.map((p) => p.id),
      [FLAVOR_CUSTOM_ID],
      'the flavor config replaces the rule set wholesale',
    );
    assert.strictEqual(state.clashMode, FLAVOR_SETTINGS.mode);
    assert.strictEqual(state.clashTolerance, FLAVOR_SETTINGS.tolerance);
    assert.strictEqual(state.clashClearance, FLAVOR_SETTINGS.clearance);
    assert.strictEqual(state.clashDuplicateTolerance, FLAVOR_SETTINGS.duplicateTolerance);
    assert.strictEqual(state.clashClusterEpsilon, FLAVOR_SETTINGS.clusterEpsilon);
    assert.strictEqual(state.clashReportTouch, FLAVOR_SETTINGS.reportTouch);
    assert.strictEqual(state.clashGroupBy, FLAVOR_SETTINGS.groupBy);

    assert.deepStrictEqual(storedCustomIds(storage), [FLAVOR_CUSTOM_ID]);
    assert.strictEqual(storedTolerance(storage), FLAVOR_SETTINGS.tolerance);
    assert.deepStrictEqual(storage.writes, [PRESETS_KEY, SETTINGS_KEY]);
  });

  // ── siblings on this branch are untouched ──────────────────────────────────

  it('createClashPreset still gates its own commit on the SaveResult', () => {
    storage.failKey = PRESETS_KEY;
    const before = state.clashPresets.length;
    const refused = state.createClashPreset({
      name: 'New rule',
      severity: 'minor',
      selectorA: 'IfcBeam',
      selectorB: 'IfcSlab',
    });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(state.clashPresets.length, before);

    storage.failKey = null;
    assert.deepStrictEqual(
      state.createClashPreset({
        name: 'New rule',
        severity: 'minor',
        selectorA: 'IfcBeam',
        selectorB: 'IfcSlab',
      }),
      { ok: true },
    );
    assert.strictEqual(state.clashPresets.length, before + 1);
  });

  it('updateClashPreset still gates its own commit on the SaveResult', () => {
    storage.failKey = PRESETS_KEY;
    assert.strictEqual(state.updateClashPreset(OLD_CUSTOM_ID, { name: 'Renamed' }).ok, false);
    assert.strictEqual(
      state.clashPresets.find((p) => p.id === OLD_CUSTOM_ID)?.name,
      'Rule from the previous flavor',
    );

    storage.failKey = null;
    assert.deepStrictEqual(state.updateClashPreset(OLD_CUSTOM_ID, { name: 'Renamed' }), { ok: true });
    assert.strictEqual(state.clashPresets.find((p) => p.id === OLD_CUSTOM_ID)?.name, 'Renamed');
  });
});
