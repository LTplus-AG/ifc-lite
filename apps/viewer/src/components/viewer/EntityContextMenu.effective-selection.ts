/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { normalizeIfcTypeName, type IfcDataStore } from '@ifc-lite/parser';

export function effectiveContextType(store: IfcDataStore, view: MutablePropertyView | null, expressId: number): string {
  const type = view?.getEntityTypeMutation(expressId)?.newType
    ?? view?.getNewEntity(expressId)?.type
    ?? store.entities.getTypeName(expressId);
  return type ? normalizeIfcTypeName(type) : '';
}

/** Source, retyped, and created ids of the clicked entity's current IFC class. */
export function sameEffectiveTypeIds(store: IfcDataStore, view: MutablePropertyView | null, expressId: number): number[] {
  const type = effectiveContextType(store, view, expressId);
  if (!type || view?.isDeleted(expressId)) return [];
  return Array.from(iterateEffectiveEntityIds(store, view, [type]), entity => entity.expressId);
}
