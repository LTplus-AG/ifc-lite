/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `serializeClashConfig` / `deserializeClashConfig` — the write and read halves
 * of clash config carried inside a flavor's `settings.clash` blob (used only by
 * `FlavorDialog.tsx` and `services/extensions/host.ts`; neither is tested).
 * `clashSlice.exclusions.test.ts` covers `applyClashFlavorConfig`, a store
 * setter fed an already-deserialized object built by hand — it never routes
 * through either function here, so the actual round trip was unexercised: a
 * mutation that drops every preset (`serializeClashConfig` returning
 * `presets: []`) is invisible to the rest of the suite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CLASH_RULE_PRESETS } from '@ifc-lite/clash';
import {
  serializeClashConfig,
  deserializeClashConfig,
  defaultPresets,
  DEFAULT_CLASH_SETTINGS,
  type ClashPreset,
  type ClashGlobalSettings,
} from './persistence.js';

/** A non-trivial fixture: one edited built-in + one custom, non-default settings. */
function nonTrivialFixture(): { presets: ClashPreset[]; settings: ClashGlobalSettings } {
  const builtins = defaultPresets();
  assert.ok(builtins.length > 0, 'expected at least one built-in preset to build a fixture from');
  const editedId = builtins[0]!.id;

  const presets: ClashPreset[] = [
    ...builtins.map((p) =>
      p.id === editedId
        ? { ...p, name: 'Edited built-in name', enabled: false, severity: 'info' as const }
        : p,
    ),
    {
      id: 'custom-fixture-1',
      name: 'My custom rule',
      description: 'a hand-authored rule',
      severity: 'minor',
      selectorA: 'IfcWall',
      selectorB: 'IfcPipeSegment',
      enabled: true,
      builtin: false,
    },
  ];

  const settings: ClashGlobalSettings = {
    mode: 'clearance',
    tolerance: 0.5,
    clearance: 2.5,
    duplicateTolerance: 0.75,
    clusterEpsilon: 30,
    reportTouch: true,
    groupBy: 'typePair',
  };

  return { presets, settings };
}

describe('clash flavor config round trip (serializeClashConfig / deserializeClashConfig)', () => {
  it('round-trips a non-trivial fixture field by field', () => {
    const { presets, settings } = nonTrivialFixture();
    const blob = serializeClashConfig(presets, settings);
    const restored = deserializeClashConfig(blob);

    assert.ok(restored, 'expected a successful deserialize');

    // Settings: every field, not a spot check.
    assert.deepStrictEqual(restored.settings, settings);

    // Presets: resolve to the same full list (built-ins + edited built-in +
    // custom), field by field — a shallow length check would pass under a
    // mutation that swaps content but preserves count.
    const editedId = CLASH_RULE_PRESETS[0]!.id;
    const restoredEdited = restored.presets.find((p) => p.id === editedId);
    assert.ok(restoredEdited, 'edited built-in must survive the round trip');
    assert.strictEqual(restoredEdited.name, 'Edited built-in name');
    assert.strictEqual(restoredEdited.enabled, false);
    assert.strictEqual(restoredEdited.severity, 'info');
    assert.strictEqual(restoredEdited.builtin, true);

    const restoredCustom = restored.presets.find((p) => p.id === 'custom-fixture-1');
    assert.ok(restoredCustom, 'custom preset must survive the round trip');
    assert.deepStrictEqual(restoredCustom, {
      id: 'custom-fixture-1',
      name: 'My custom rule',
      description: 'a hand-authored rule',
      severity: 'minor',
      selectorA: 'IfcWall',
      selectorB: 'IfcPipeSegment',
      enabled: true,
      builtin: false,
    });

    // Every other built-in came back untouched, at its default.
    const untouchedIds = CLASH_RULE_PRESETS.filter((preset) => preset.id !== editedId).map((preset) => preset.id);
    for (const id of untouchedIds) {
      const found: ClashPreset | undefined = restored.presets.find((x) => x.id === id);
      const orig = CLASH_RULE_PRESETS.find((x) => x.id === id)!;
      assert.ok(found, `expected untouched built-in ${id} to be present`);
      assert.strictEqual(found.name, orig.name);
      assert.strictEqual(found.enabled, true);
      assert.strictEqual(found.builtin, true);
    }

    // Full preset count: all built-ins + the one custom, no drops/dupes.
    assert.strictEqual(restored.presets.length, CLASH_RULE_PRESETS.length + 1);
  });

  it('returns null for a garbage blob', () => {
    assert.strictEqual(deserializeClashConfig(null), null);
    assert.strictEqual(deserializeClashConfig(undefined), null);
    assert.strictEqual(deserializeClashConfig('not an object'), null);
    assert.strictEqual(deserializeClashConfig(42), null);
  });

  it('an array blob is typeof "object" so it is NOT rejected — it degrades to defaults, not null', () => {
    // `!blob || typeof blob !== 'object'` treats an array as a valid object,
    // since `[1, 2, 3].presets`/`.settings` are both undefined it falls through
    // to the same "missing keys" path as `{}`. Documented, not asserted as a bug.
    const restored = deserializeClashConfig([1, 2, 3]);
    assert.ok(restored, 'an array blob is silently accepted rather than rejected');
    assert.strictEqual(restored.presets.length, CLASH_RULE_PRESETS.length);
    assert.deepStrictEqual(restored.settings, DEFAULT_CLASH_SETTINGS);
  });

  it('accepts a blob whose schemaVersion is absent, garbage, or from the future (no version gate)', () => {
    const { presets, settings } = nonTrivialFixture();
    const blob = serializeClashConfig(presets, settings);

    const futureVersion = deserializeClashConfig({ ...blob, schemaVersion: 999 });
    assert.ok(futureVersion, 'a future schemaVersion is silently accepted');
    assert.strictEqual(futureVersion.presets.length, CLASH_RULE_PRESETS.length + 1);

    const missingVersion = deserializeClashConfig({ settings: blob.settings, presets: blob.presets });
    assert.ok(missingVersion, 'a missing schemaVersion is silently accepted');
    assert.strictEqual(missingVersion.presets.length, CLASH_RULE_PRESETS.length + 1);

    const garbageVersion = deserializeClashConfig({ ...blob, schemaVersion: 'not-a-version' });
    assert.ok(garbageVersion, 'a non-numeric schemaVersion is silently accepted');
    assert.strictEqual(garbageVersion.presets.length, CLASH_RULE_PRESETS.length + 1);
  });

  it('degrades missing `presets` to just the built-in defaults, and missing `settings` to defaults', () => {
    const noPresets = deserializeClashConfig({ schemaVersion: 1, settings: DEFAULT_CLASH_SETTINGS });
    assert.ok(noPresets);
    assert.strictEqual(noPresets.presets.length, CLASH_RULE_PRESETS.length);
    assert.ok(noPresets.presets.every((p) => p.builtin && p.enabled));

    const noSettings = deserializeClashConfig({ schemaVersion: 1, presets: [] });
    assert.ok(noSettings);
    assert.deepStrictEqual(noSettings.settings, DEFAULT_CLASH_SETTINGS);

    const empty = deserializeClashConfig({});
    assert.ok(empty);
    assert.strictEqual(empty.presets.length, CLASH_RULE_PRESETS.length);
    assert.deepStrictEqual(empty.settings, DEFAULT_CLASH_SETTINGS);
  });

  it('exercises both a built-in id and a non-built-in id in the same stored list (builtinPresetIds re-derivation)', () => {
    const restored = deserializeClashConfig({
      schemaVersion: 1,
      settings: DEFAULT_CLASH_SETTINGS,
      presets: [
        // A built-in id stored as an "override" — must come back builtin:true
        // and merged with the other built-ins (mergeStoredPresets), not
        // duplicated alongside the canonical entry.
        {
          id: CLASH_RULE_PRESETS[0]!.id,
          name: 'Renamed via override',
          description: '',
          severity: 'major',
          selectorA: CLASH_RULE_PRESETS[0]!.selectorA,
          selectorB: CLASH_RULE_PRESETS[0]!.selectorB,
          enabled: true,
          builtin: false, // deliberately wrong on the wire — deserializer must re-derive it
        },
        // A truly custom id — must come back builtin:false.
        {
          id: 'not-a-builtin-id',
          name: 'Custom',
          description: '',
          severity: 'minor',
          selectorA: 'IfcWall',
          selectorB: 'IfcWall',
          enabled: true,
          builtin: true, // deliberately wrong on the wire — deserializer must re-derive it
        },
      ],
    });
    assert.ok(restored);

    const overriddenBuiltin = restored.presets.find((p) => p.id === CLASH_RULE_PRESETS[0]!.id);
    assert.ok(overriddenBuiltin);
    assert.strictEqual(overriddenBuiltin.builtin, true, 're-derived from builtinPresetIds(), not the stored flag');
    assert.strictEqual(overriddenBuiltin.name, 'Renamed via override');
    // No duplicate entry for this id.
    assert.strictEqual(restored.presets.filter((p) => p.id === CLASH_RULE_PRESETS[0]!.id).length, 1);

    const custom = restored.presets.find((p) => p.id === 'not-a-builtin-id');
    assert.ok(custom);
    assert.strictEqual(custom.builtin, false, 're-derived from builtinPresetIds(), not the stored flag');

    // Every other built-in is still present at its default.
    assert.strictEqual(restored.presets.length, CLASH_RULE_PRESETS.length + 1);
  });
});
