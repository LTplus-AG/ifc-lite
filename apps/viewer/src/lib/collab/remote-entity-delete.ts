/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { unregisterEntityPath } from './entity-paths';

/** Apply a remote tombstone atomically with path removal. */
export function deleteRemoteOverlayEntity(
  store: IfcDataStore,
  view: MutablePropertyView | undefined,
  entityId: number,
): boolean {
  if (!view) return false;
  view.deleteEntity(entityId);
  unregisterEntityPath(store, entityId);
  return true;
}
