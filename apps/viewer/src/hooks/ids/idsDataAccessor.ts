/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS Data Accessor — thin wrapper around the canonical bridge.
 *
 * The actual `IfcDataStore → IFCDataAccessor` translation lives in
 * `@ifc-lite/ids/bridge` so the viewer, the corpus-parity harness,
 * and the MCP server share one implementation. Keeping this file as
 * a re-export preserves the existing import path for callers that
 * pass through `_modelId` (currently unused but preserved for API
 * stability — the validator already takes a `modelInfo` separately).
 */

import type { IFCDataAccessor } from '@ifc-lite/ids';
import { createDataAccessor as createBridgeAccessor } from '@ifc-lite/ids/bridge';
import type { IfcDataStore } from '@ifc-lite/parser';

export function createDataAccessor(
  dataStore: IfcDataStore,
  _modelId: string
): IFCDataAccessor {
  return createBridgeAccessor(dataStore);
}
