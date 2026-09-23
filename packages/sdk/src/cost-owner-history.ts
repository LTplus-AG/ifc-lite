/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntityIds, type MutablePropertyView, type StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';

/**
 * First live `IfcOwnerHistory`, including one created or retyped in the
 * overlay. Pass the editor's mutation view to see the full effective entity
 * set. The optional view preserves the older source-only call signature;
 * that path still skips tombstones through `editor.hasEntity`.
 */
export function resolveLiveOwnerHistoryId(
  store: IfcDataStore,
  editor: StoreEditor,
  view?: MutablePropertyView,
): number | null {
  for (const { expressId } of iterateEffectiveEntityIds(store, view, ['IFCOWNERHISTORY'])) {
    if (editor.hasEntity(expressId)) return expressId;
  }
  return null;
}
