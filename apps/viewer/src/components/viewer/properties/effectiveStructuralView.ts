/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import { effectiveMetadataRecord, type IfcDataStore, type StructuralExtractionView } from '@ifc-lite/parser';

/** Adapt the viewer's editable overlay to the parser's structural read model. */
export function effectiveStructuralView(
  mutationView: MutablePropertyView | null | undefined,
  store: IfcDataStore,
): StructuralExtractionView | undefined {
  if (!mutationView) return undefined;
  return {
    isDeleted: (expressId) => mutationView.isDeleted(expressId),
    getNewEntities: () => mutationView.getNewEntities(),
    getNewEntitiesOfType: (type) => mutationView.getNewEntitiesOfType(type),
    getNewEntity: (expressId) => mutationView.getNewEntity(expressId),
    getTypeMutations: () => mutationView.getTypeMutations(),
    getTombstones: () => mutationView.getTombstones(),
    readEntity: (expressId) => {
      const record = effectiveMetadataRecord(store, expressId, mutationView);
      return record ? { expressId, type: record.type, attrs: record.attributes,
        globalId: typeof record.attributes[0] === 'string' ? record.attributes[0] : '' } : undefined;
    },
  };
}
