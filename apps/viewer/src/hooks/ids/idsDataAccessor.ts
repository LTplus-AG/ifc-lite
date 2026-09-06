/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS Data Accessor — thin wrapper around the canonical bridge.
 *
 * The actual `IfcDataStore → IFCDataAccessor` translation lives in
 * `@ifc-lite/ids/bridge` so the viewer, the buildingSMART corpus harness
 * (`packages/ids/src/__corpus__/corpus.test.ts`) and the MCP server share
 * one implementation. Keeping this file as
 * a re-export preserves the existing import path for callers that
 * pass through `_modelId` (currently unused but preserved for API
 * stability — the validator already takes a `modelInfo` separately).
 *
 * `mutationView`, when passed, layers any pending property edits (e.g. an
 * IDS correction applied through `MutablePropertyView.setProperty`, #3929)
 * on top of the store's own data — so a re-run of validation against THIS
 * accessor actually sees the correction instead of the pre-edit value.
 * Every other read (attributes, classifications, materials, partOf) is
 * untouched; only property reads consult the overlay.
 */

import type { IFCDataAccessor } from '@ifc-lite/ids';
import {
  createDataAccessor as createBridgeAccessor,
  type PropertyOverride,
} from '@ifc-lite/ids/bridge';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';

/**
 * Build the bridge's property-overlay resolver from a `MutablePropertyView`.
 * Only property mutations with a scalar value are projected — list/array
 * property values aren't part of this overlay's contract and are skipped
 * rather than mis-rendered.
 *
 * `getMutationsForEntity()` (`mutationHistory`) is used ONLY to enumerate
 * WHICH (psetName, propName) pairs this entity has ever touched — history is
 * append-only (undo re-applies the inverse mutation with `skipHistory=true`
 * "to avoid polluting mutation history", `mutationSlice.ts`, so it never
 * pops), but the identity of a touched key never becomes wrong, only stale.
 * The actual current state/value for each key comes from
 * `MutablePropertyView.getPropertyMutation()` — the live overlay map
 * (`propertyMutations`), same source `hasChanges()` / `getModifiedEntityCount()`
 * read instead of history, for the same reason. Reading `mutation.newValue`
 * straight from history here was the bug: after an undo, the live overlay
 * had reverted but this resolver still reported the pre-undo (corrected)
 * value as an active override, so IDS re-validation kept reporting PASS on
 * data that had actually reverted to failing.
 */
function buildOverlayResolver(mutationView: MutablePropertyView) {
  return (expressId: number): PropertyOverride[] | undefined => {
    const mutations = mutationView.getMutationsForEntity(expressId);
    if (mutations.length === 0) return undefined;

    const seen = new Set<string>();
    const overrides: PropertyOverride[] = [];
    for (const mutation of mutations) {
      if (!mutation.psetName || !mutation.propName) continue;
      const dedupeKey = JSON.stringify([mutation.psetName, mutation.propName]);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // The live, current state of this key — never the (possibly stale)
      // `mutation` object itself. `undefined` means an undo unwound this key
      // back to "no override at all" (see `deleteProperty`'s
      // `deletePropertyMutation` branch): skip it so the read falls through
      // to the base value, exactly as if it had never been touched.
      const live = mutationView.getPropertyMutation(expressId, mutation.psetName, mutation.propName);
      if (!live) continue;

      if (live.operation === 'DELETE') {
        overrides.push({ psetName: mutation.psetName, propName: mutation.propName, value: null, deleted: true });
        continue;
      }

      const value = live.value ?? null;
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        // Array/list values aren't part of the overlay contract — skip
        // rather than write a shape the bridge doesn't expect.
        continue;
      }
      overrides.push({ psetName: mutation.psetName, propName: mutation.propName, value });
    }
    return overrides.length > 0 ? overrides : undefined;
  };
}

export function createDataAccessor(
  dataStore: IfcDataStore,
  _modelId: string,
  mutationView?: MutablePropertyView | null
): IFCDataAccessor {
  return createBridgeAccessor(
    dataStore,
    mutationView ? buildOverlayResolver(mutationView) : undefined
  );
}
