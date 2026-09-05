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
 * Only property mutations (CREATE/UPDATE/DELETE_PROPERTY) with a scalar
 * value are projected — list/array property values aren't part of this
 * overlay's contract and are skipped rather than mis-rendered.
 */
function buildOverlayResolver(mutationView: MutablePropertyView) {
  return (expressId: number): PropertyOverride[] | undefined => {
    const mutations = mutationView.getMutationsForEntity(expressId);
    if (mutations.length === 0) return undefined;

    const overrides: PropertyOverride[] = [];
    for (const mutation of mutations) {
      if (!mutation.psetName || !mutation.propName) continue;

      if (mutation.type === 'DELETE_PROPERTY') {
        overrides.push({ psetName: mutation.psetName, propName: mutation.propName, value: null, deleted: true });
        continue;
      }
      if (mutation.type !== 'CREATE_PROPERTY' && mutation.type !== 'UPDATE_PROPERTY') continue;

      const value = mutation.newValue;
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        // Array/list values aren't part of the overlay contract — skip
        // rather than write a shape the bridge doesn't expect.
        continue;
      }
      overrides.push({ psetName: mutation.psetName, propName: mutation.propName, value });
    }
    // History is append-only and chronological; later entries for the same
    // pset/prop key correctly overwrite earlier ones in the bridge's
    // apply-in-order overlay, so no de-duplication is needed here.
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
