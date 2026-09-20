/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import {
  effectiveRelationshipEdges,
  resolveEffectiveRelationshipOverlay,
  type EffectiveRelationshipOverlay,
  type IfcDataStore,
} from '@ifc-lite/parser';

export interface QueuedRelationshipEdge {
  relationshipId: number;
  relationshipType: string;
  direction: 'forward' | 'inverse';
  targetId: number;
}

export function effectiveMutationRelationships(
  store: IfcDataStore,
  view: MutablePropertyView,
): EffectiveRelationshipOverlay {
  return resolveEffectiveRelationshipOverlay(store, {
    createdEntities: () => view.getNewEntities(),
    mutatedEntityIds: () => view.getMutations().map(mutation => mutation.entityId),
    namedAttributes: expressId => view.getAttributeMutationsForEntity(expressId)
      .map(({ name, value }) => [name, value] as const),
    positionalAttributes: expressId => view.getPositionalMutationsForEntity(expressId) ?? [],
    entityType: expressId => view.getEntityTypeMutation(expressId)?.newType,
    isDeleted: expressId => view.isDeleted(expressId),
  });
}

export function foldMutationRelationshipEdges(
  store: IfcDataStore,
  view: MutablePropertyView,
  expressId: number,
): QueuedRelationshipEdge[] {
  return effectiveRelationshipEdges(effectiveMutationRelationships(store, view), id => view.isDeleted(id), expressId);
}

export function foldMutationRelated(
  store: IfcDataStore,
  view: MutablePropertyView,
  relationshipType: string,
  direction: 'forward' | 'inverse',
  expressId: number,
): number[] {
  return effectiveRelationshipEdges(
    effectiveMutationRelationships(store, view),
    id => view.isDeleted(id),
    expressId,
    relationshipType,
  ).filter(edge => edge.direction === direction).map(edge => edge.targetId);
}
