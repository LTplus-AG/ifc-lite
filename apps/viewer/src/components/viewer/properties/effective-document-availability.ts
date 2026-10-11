/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';

const DOCUMENT_KINDS = new Set(['IFCDOCUMENTREFERENCE', 'IFCDOCUMENTINFORMATION', 'IFCRELASSOCIATESDOCUMENT', 'IFCRELDEFINESBYTYPE']);
/** Missing native membership inputs cannot prove an empty/current document population (#7187). */
export function documentPopulationUnavailable(store: IfcDataStore | null | undefined, view: MutablePropertyView | null | undefined): boolean {
  if (!store || store.source?.length) return false;
  if (!store.onDemandDocumentMap && !store.relationships) return true;
  return Boolean(view?.getEffectiveChanges().some(change => {
    // Fully authored native rows do not depend on unavailable source bytes.
    if (view.getNewEntity(change.entityId)) return false;
    // @raw-entity-enumeration-ok source class kind only determines whether absent bytes prevent proving current document membership
    const types = [store.entityIndex.byId.get(change.entityId)?.type, store.entities.getTypeName(change.entityId),
      view.getEntityTypeMutation(change.entityId)?.newType];
    return types.some(type => type !== undefined && DOCUMENT_KINDS.has(type.toUpperCase()));
  }));
}
