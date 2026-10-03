/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import { resolveEffectiveRelationshipOverlay, normalizeIfcTypeName, type EffectiveRelationshipOverlay, type IfcDataStore } from '@ifc-lite/parser';

export function effectiveMutationRelationships(
  store: IfcDataStore,
  view: MutablePropertyView,
): EffectiveRelationshipOverlay {
  return resolveEffectiveRelationshipOverlay(store, {
    createdEntities: () => view.getNewEntities(),
    // Current overlay entries include edits made with skipHistory (undo and
    // atomic replay); append-only history can also retain undone edits.
    mutatedEntityIds: () => view.getEffectiveChanges().map(change => change.entityId),
    namedAttributes: expressId => view.getAttributeMutationsForEntity(expressId)
      .map(({ name, value }) => [name, value] as const),
    positionalAttributes: expressId => view.getPositionalMutationsForEntity(expressId) ?? [],
    entityType: expressId => view.getEntityTypeMutation(expressId)?.newType,
    isDeleted: expressId => view.isDeleted(expressId),
  });
}


/** Source, retyped and authored IFC classes share the same effective view. */
export function effectiveContextType(store: IfcDataStore, view: MutablePropertyView | null, expressId: number): string {
  const type = view?.getEntityTypeMutation(expressId)?.newType
    ?? view?.getNewEntity(expressId)?.type
    ?? store.entities.getTypeName(expressId);
  return type ? normalizeIfcTypeName(type) : '';
}
