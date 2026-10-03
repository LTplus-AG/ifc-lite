/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { effectiveMutationRelationships } from '../../../../../packages/create/src/in-store/edit/effective-mutation-view.js';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import {
  effectiveRelationshipEdges,
  type IfcDataStore,
} from '@ifc-lite/parser';

export interface QueuedRelationshipEdge {
  relationshipId: number;
  relationshipType: string;
  direction: 'forward' | 'inverse';
  targetId: number;
}

export { effectiveMutationRelationships };

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
