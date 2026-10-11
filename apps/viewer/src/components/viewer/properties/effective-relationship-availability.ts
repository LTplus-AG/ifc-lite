/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';

/** Native graph rows survive transport; unreadable live edits cannot prove totals (#7179). */
export function relationshipPopulationUnavailable(
  store: IfcDataStore | null | undefined,
  view: MutablePropertyView | null | undefined,
): boolean {
  if (!store || store.source?.length) return false;
  if (!store.relationships) return true;
  return Boolean(view?.getEffectiveChanges().some(change => {
    // Complete authored records do not require the missing original source.
    if (view.getNewEntity(change.entityId)) return false;
    // @raw-entity-enumeration-ok Immutable indexed kind identifies an unreadable edited source relationship; current membership remains unavailable, not inferred from the index.
    const types = [store.entityIndex.byId.get(change.entityId)?.type,
      store.entities.getTypeName(change.entityId), view.getEntityTypeMutation(change.entityId)?.newType];
    return types.some(type => type?.toUpperCase().startsWith('IFCREL'));
  }));
}
