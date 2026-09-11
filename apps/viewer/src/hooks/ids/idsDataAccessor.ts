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
 *
 * The view -> `PropertyOverride[]` projection itself lives in
 * `@/lib/ids/property-overlay-snapshot`, not here, because the IDS worker
 * needs the same projection and cannot import a `MutablePropertyView`
 * (#3946). This accessor and the worker's accessor are handed resolvers
 * built by the same function from the same snapshot, so they cannot drift.
 */

import type { IFCDataAccessor } from '@ifc-lite/ids';
import { createDataAccessor as createBridgeAccessor } from '@ifc-lite/ids/bridge';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';

import {
  snapshotPropertyOverlay,
  overlayResolverFromSnapshot,
} from '@/lib/ids/property-overlay-snapshot';

export function createDataAccessor(
  dataStore: IfcDataStore,
  _modelId: string,
  mutationView?: MutablePropertyView | null
): IFCDataAccessor {
  return createBridgeAccessor(
    dataStore,
    mutationView
      ? overlayResolverFromSnapshot(snapshotPropertyOverlay(mutationView))
      : undefined
  );
}
