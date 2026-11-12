/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';

const inventories = new WeakMap<IfcDataStore, { source: IfcDataStore['source']; missing: Map<string, number[]> }>();
const classes = ['IFCRELASSOCIATESMATERIAL', 'IFCRELASSOCIATESCLASSIFICATION', 'IFCRELASSOCIATESDOCUMENT', 'IFCRELDEFINESBYTYPE'];

/** Keep rows the byte scanner could not index on the canonical source reader.
 * Publication prepares this metadata-only inventory; no source blocks are read. */
export function prepareSelectionRelationships(store: IfcDataStore): Map<string, number[]> {
  const old = inventories.get(store);
  if (old?.source === store.source) return old.missing;
  const represented = new Set(store.relationships.forward.edgeRelIds);
  for (const id of store.relationships.forward.shadowedRelIds ?? []) represented.add(id);
  const missing = new Map<string, number[]>();
  // @raw-entity-enumeration-ok source rows absent from the graph must still reach the canonical effective reader
  for (const type of classes) missing.set(type, (store.entityIndex.byType.get(type) ?? []).filter(id => !represented.has(id)));
  inventories.set(store, { source: store.source, missing });
  return missing;
}

/** #9947: source rows incident to one subject, plus edits that can move endpoints
 * INTO that subject. Partial providers keep the complete inventory contract. */
export function selectionRelationshipIds(store: IfcDataStore, view: {
  getEffectiveChanges?(): ReadonlyArray<{ entityId: number; kind: string }>;
}, entityId: number | undefined, kinds: readonly RelationshipType[], sourceTypes: readonly string[]): number[] | null {
  if (entityId === undefined || !store.source?.length || !store.relationships?.inverse
    || !store.relationships.forward?.edgeRelIds || typeof store.relationships.inverse.getEdges !== 'function'
    || !view.getEffectiveChanges || store.relationshipsPending) return null;
  const ids = new Set<number>();
  for (const kind of kinds) {
    for (const edge of store.relationships.inverse.getEdges(entityId, kind)) {
      ids.add(edge.relationshipId);
      for (const id of edge.shadowedRelationshipIds ?? []) ids.add(id);
    }
  }
  for (const change of view.getEffectiveChanges()) {
    if (change.kind === 'attribute' || change.kind === 'type' || change.kind === 'entity-deleted') ids.add(change.entityId);
  }
  for (const type of sourceTypes) for (const id of prepareSelectionRelationships(store).get(type) ?? []) ids.add(id);
  // The old inventory visited raw type buckets in source order, then retypes.
  // Graph adjacency orders targets instead; retain the original displayed order.
  return [...ids].sort((a, b) => {
    const left = store.entityIndex.byId.get(a), right = store.entityIndex.byId.get(b);
    const rank = (type: string | undefined) => { const n = type ? sourceTypes.indexOf(type) : -1; return n < 0 ? sourceTypes.length : n; };
    return rank(left?.type) - rank(right?.type) || (left?.byteOffset ?? a) - (right?.byteOffset ?? b);
  });
}
