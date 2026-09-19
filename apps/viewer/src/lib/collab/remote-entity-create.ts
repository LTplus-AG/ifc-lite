/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { StoreEditor, type MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { entityForPath, registerEntityPath } from './entity-paths';

/** Materialize and map a peer-created CRDT entity in an already-loaded STEP model. */
export function createRemoteOverlayEntity(
  store: IfcDataStore,
  view: MutablePropertyView,
  entityPath: string,
  ifcClass: string,
): boolean {
  if (entityForPath(store, entityPath) !== null) return false;
  const created = new StoreEditor(store, view).addEntity(ifcClass, []);
  registerEntityPath(store, created.expressId, entityPath);
  return true;
}
