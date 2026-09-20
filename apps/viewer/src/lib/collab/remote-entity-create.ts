/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { StoreEditor, type MutablePropertyView } from '@ifc-lite/mutations';
import { getInheritanceChainAcrossSchemas, isInstantiable, type IfcDataStore } from '@ifc-lite/parser';
import { entityForPath, registerEntityPath, unregisterEntityPath } from './entity-paths';
import { applyRemoteAttribute } from './mutation-bridge';
export { deleteRemoteOverlayEntity } from './remote-entity-delete';

export function createRemoteOverlayEntity(
  store: IfcDataStore,
  view: MutablePropertyView,
  entityPath: string,
  ifcClass: string,
  attributes: Readonly<Record<string, unknown>>,
  onAttributeRejected?: (reason: string) => void,
  sourceExpressId?: number,
): boolean {
  if (!isInstantiable(ifcClass)) return false;
  const currentOwner = entityForPath(store, entityPath);
  if (currentOwner !== null) {
    if (!view.isDeleted(currentOwner)) return false;
    // A local delete keeps the path registration so outbound tombstoning can
    // resolve it. A later peer recreation of the same room path is a new live
    // entity; release the dead owner before rebinding the reverse map.
    unregisterEntityPath(store, currentOwner);
  }
  const guid = entityPath.slice(entityPath.lastIndexOf('/') + 1);
  if (sourceExpressId !== undefined && !view.isDeleted(sourceExpressId)) {
    const source = store.getEntity?.(sourceExpressId);
    if (source && !store.entities.getGlobalId(sourceExpressId) && source.type.toUpperCase() === ifcClass.toUpperCase()) {
      registerEntityPath(store, sourceExpressId, entityPath);
      for (const [name, value] of Object.entries(attributes)) {
        const rejected = applyRemoteAttribute(view, store, sourceExpressId, name, value);
        if (rejected) onAttributeRejected?.(rejected);
      }
      return true;
    }
  }
  const initial = getInheritanceChainAcrossSchemas(ifcClass).includes('IfcRoot') ? [guid] : [];
  const created = new StoreEditor(store, view).addEntity(ifcClass, initial);
  registerEntityPath(store, created.expressId, entityPath);
  for (const [name, value] of Object.entries(attributes)) {
    const rejected = applyRemoteAttribute(view, store, created.expressId, name, value);
    if (rejected) onAttributeRejected?.(rejected);
  }
  return true;
}
