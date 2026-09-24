/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import { normalizeIfcTypeName, type IfcDataStore } from '@ifc-lite/parser';

/** Class of the selected record as the current session will export it. */
export function effectiveSelectedClass(
  store: IfcDataStore | null | undefined,
  view: MutablePropertyView | null | undefined,
  expressId: number,
): string | null {
  if (view?.isDeleted(expressId)) return null;
  const edited = view?.getEntityTypeMutation(expressId)?.newType;
  if (edited) return normalizeIfcTypeName(edited);
  const created = view?.getNewEntity(expressId);
  if (created) return normalizeIfcTypeName(created.type);
  if (!store) return null;
  const tableType = store.entities.getTypeName(expressId);
  if (tableType !== 'Unknown') return tableType;
  // @raw-entity-enumeration-ok point lookup for a selected non-product; the overlay has already supplied deletes, creations and retypes
  const sourceType = store.entityIndex.byId.get(expressId)?.type;
  return sourceType ? normalizeIfcTypeName(sourceType) : null;
}
