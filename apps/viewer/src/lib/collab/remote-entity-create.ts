/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { StoreEditor, type MutablePropertyView } from '@ifc-lite/mutations';
import { getInheritanceChainAcrossSchemas, isInstantiable, type IfcDataStore } from '@ifc-lite/parser';
import { entityForPath, registerEntityPath } from './entity-paths';
import { applyRemoteAttribute } from './mutation-bridge';
export { deleteRemoteOverlayEntity } from './remote-entity-delete';

export function createRemoteOverlayEntity(
  store: IfcDataStore,
  view: MutablePropertyView,
  entityPath: string,
  ifcClass: string,
  attributes: Readonly<Record<string, unknown>>,
  onAttributeRejected?: (reason: string) => void,
): boolean {
  if (entityForPath(store, entityPath) !== null) return false;
  if (!isInstantiable(ifcClass)) return false;
  const guid = entityPath.slice(entityPath.lastIndexOf('/') + 1);
  const sourceMatch = /^ifc-lite-ref-(\d+)(?:-\d+)?$/.exec(guid);
  if (sourceMatch) {
    const sourceId = Number(sourceMatch[1]);
    const source = store.getEntity?.(sourceId);
    if (source && !store.entities.getGlobalId(sourceId) && source.type.toUpperCase() === ifcClass.toUpperCase()) {
      registerEntityPath(store, sourceId, entityPath);
      for (const [name, value] of Object.entries(attributes)) {
        const rejected = applyRemoteAttribute(view, store, sourceId, name, value);
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
