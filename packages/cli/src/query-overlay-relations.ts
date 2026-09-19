/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import {
  effectiveRelationshipEdges,
  resolveEffectiveRelationshipOverlay,
  type IfcDataStore,
} from '@ifc-lite/parser';

function effective(store: IfcDataStore, view: MutablePropertyView) {
  return resolveEffectiveRelationshipOverlay(store, {
    createdEntities: () => view.getNewEntities(),
    mutatedEntityIds: () => view.getMutations().map(mutation => mutation.entityId),
    namedAttributes: id => view.getAttributeMutationsForEntity(id).map(({ name, value }) => [name, value] as const),
    positionalAttributes: id => view.getPositionalMutationsForEntity(id) ?? [],
    attributeWriteOrder: id => view.getMutationsForEntity(id).map(mutation => mutation.attributeName ?? ''),
    isDeleted: id => view.isDeleted(id),
  });
}

export function foldQueuedRelationshipEdges(store: IfcDataStore, view: MutablePropertyView, expressId: number) {
  return effectiveRelationshipEdges(effective(store, view), id => view.isDeleted(id), expressId);
}

export function foldQueuedRelated(
  store: IfcDataStore,
  view: MutablePropertyView,
  relType: string,
  direction: 'forward' | 'inverse',
  expressId: number,
): number[] {
  return effectiveRelationshipEdges(effective(store, view), id => view.isDeleted(id), expressId, relType)
    .filter(edge => edge.direction === direction)
    .map(edge => edge.targetId);
}

export function supersededRelationshipIds(store: IfcDataStore, view: MutablePropertyView): ReadonlySet<number> {
  return effective(store, view).supersededSourceIds;
}
