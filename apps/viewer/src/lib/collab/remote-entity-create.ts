/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { StoreEditor, type MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { entityForPath, registerEntityPath } from './entity-paths';
import { applyRemoteAttribute } from './remote-attribute';

/** Materialize and map a peer-created CRDT entity in an already-loaded STEP model. */
export function createRemoteOverlayEntity(
  store: IfcDataStore,
  view: MutablePropertyView,
  entityPath: string,
  ifcClass: string,
  attributes: Readonly<Record<string, unknown>> = {},
): boolean {
  const existingId = entityForPath(store, entityPath);
  if (existingId !== null) {
    if (!view.isDeleted(existingId)) return false;
    if (store.entityIndex.byId.has(existingId)) {
      view.restoreFromTombstone(existingId);
    } else {
      view.restoreNewEntity({ expressId: existingId, type: ifcClass, attributes: [] });
    }
    registerEntityPath(store, existingId, entityPath);
    for (const [name, value] of Object.entries(attributes)) {
      applyRemoteAttribute(view, store, existingId, name, value);
    }
    return true;
  }
  const created = new StoreEditor(store, view).addEntity(ifcClass, []);
  registerEntityPath(store, created.expressId, entityPath);
  for (const [name, value] of Object.entries(attributes)) {
    applyRemoteAttribute(view, store, created.expressId, name, value);
  }
  return true;
}
