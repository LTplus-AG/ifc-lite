/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import { getAttributeNames, normalizeIfcTypeName, type StructuralExtractionView } from '@ifc-lite/parser';

/** Adapt the viewer's editable overlay to the parser's structural read model. */
export function effectiveStructuralView(
  mutationView: MutablePropertyView | null | undefined,
): StructuralExtractionView | undefined {
  if (!mutationView) return undefined;
  return {
    isDeleted: (expressId) => mutationView.isDeleted(expressId),
    getNewEntities: () => mutationView.getNewEntities(),
    getNewEntitiesOfType: (type) => mutationView.getNewEntitiesOfType(type),
    getNewEntity: (expressId) => mutationView.getNewEntity(expressId),
    getTypeMutations: () => mutationView.getTypeMutations(),
    getTombstones: () => mutationView.getTombstones(),
    readEntity: (expressId, effectiveType, source) => {
      const fresh = mutationView.getNewEntity(expressId);
      const attrs = source?.attrs.slice() ?? [...(fresh?.attributes ?? [])];
      for (const [index, value] of mutationView.getPositionalMutationsForEntity(expressId) ?? []) attrs[index] = value;
      const type = normalizeIfcTypeName(effectiveType);
      for (const mutation of mutationView.getAttributeMutationsForEntity(expressId)) {
        const index = getAttributeNames(type).indexOf(mutation.name);
        if (index >= 0) attrs[index] = mutation.value;
      }
      return {
        expressId,
        type,
        attrs,
        globalId: typeof attrs[0] === 'string' ? attrs[0] : source?.globalId ?? '',
      };
    },
  };
}
