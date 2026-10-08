/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import { resolveEffectiveRelationshipOverlay, normalizeIfcTypeName, type EffectiveRelationshipOverlay, type IfcDataStore } from '@ifc-lite/parser';

export function effectiveMutationRelationships(
  store: IfcDataStore,
  view: MutablePropertyView,
): EffectiveRelationshipOverlay {
  // A transported source-empty store must not read an original byte closure.
  // Complete authored records remain available; source membership is unknown
  // and read-only viewer folds explicitly retain source-origin rows (#7179).
  const readable = store.source?.length ? store : { ...store, getEntity: () => null };
  const result = resolveEffectiveRelationshipOverlay(readable, {
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
  if (store.source?.length) return result;
  // Opaque source records cannot be reconstructed, but the indexed original
  // relationship kind proves its immutable graph edges are superseded. Native
  // authoring must not use those original endpoints as current membership.
  const supersededSourceIds = new Set(result.supersededSourceIds);
  for (const change of view.getEffectiveChanges()) {
    if (view.getNewEntity(change.entityId)) continue;
    // @raw-entity-enumeration-ok Immutable indexed kind identifies superseded original graph edges when source bytes are absent; it does not resolve current endpoints.
    const types = [store.entityIndex.byId.get(change.entityId)?.type,
      store.entities.getTypeName(change.entityId), view.getEntityTypeMutation(change.entityId)?.newType];
    if (types.some(type => type?.toUpperCase().startsWith('IFCREL'))) supersededSourceIds.add(change.entityId);
  }
  return { ...result, supersededSourceIds };
}


/** Source, retyped and authored IFC classes share the same effective view. */
export function effectiveContextType(store: IfcDataStore, view: MutablePropertyView | null, expressId: number): string {
  const type = view?.getEntityTypeMutation(expressId)?.newType
    ?? view?.getNewEntity(expressId)?.type
    ?? store.entities.getTypeName(expressId);
  return type ? normalizeIfcTypeName(type) : '';
}
