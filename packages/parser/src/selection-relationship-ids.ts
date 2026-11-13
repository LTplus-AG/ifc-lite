/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { selectionEditedRelationshipsForSubject, type SelectionEditView } from './selection-relationship-edits.js';

const inventories = new WeakMap<IfcDataStore, { source: IfcDataStore['source']; missing: Map<string, number[]> }>();
const classes = ['IFCRELASSOCIATESMATERIAL', 'IFCRELASSOCIATESCLASSIFICATION', 'IFCRELASSOCIATESDOCUMENT', 'IFCRELDEFINESBYTYPE', 'IFCRELDEFINESBYPROPERTIES'];

/** Keep rows the byte scanner could not index on the canonical source reader.
 * Legacy stores without parser coverage use this metadata-only fallback; no
 * source blocks are read while finding the missing rows. */
function legacyMissingRelationships(store: IfcDataStore): Map<string, number[]> {
  const old = inventories.get(store);
  if (old?.source === store.source) return old.missing;
  const represented = new Set(store.relationships.forward.edgeRelIds);
  for (const id of store.relationships.forward.shadowedRelIds ?? []) represented.add(id);
  const missing = new Map<string, number[]>();
  for (const type of classes) {
    // @raw-entity-enumeration-ok source rows absent from the graph must still reach the canonical effective reader
    missing.set(type, (store.entityIndex.byType.get(type) ?? []).filter(id => !represented.has(id)));
  }
  inventories.set(store, { source: store.source, missing });
  return missing;
}

/** #9947: source rows incident to one subject, plus edits that can move endpoints
 * INTO that subject. Partial providers keep the complete inventory contract. */
export function selectionRelationshipIds(store: IfcDataStore, view: SelectionEditView, entityId: number | undefined, kinds: readonly RelationshipType[], sourceTypes: readonly string[]): number[] | null {
  if (entityId === undefined || !store.source?.length || !store.relationships?.inverse
    || !store.relationships.forward?.edgeRelIds || typeof store.relationships.inverse.getEdges !== 'function'
    || (!view.getAttributeOverrideEntityIds && !view.getEffectiveChanges)
    || (store.relationshipsPending && !sourceTypes.every(type => type === 'IFCRELDEFINESBYTYPE' || type === 'IFCRELDEFINESBYPROPERTIES'))) return null;
  const ids = new Set<number>();
  for (const kind of kinds) {
    for (const edge of store.relationships.inverse.getEdges(entityId, kind)) {
      ids.add(edge.relationshipId);
      for (const id of edge.shadowedRelationshipIds ?? []) ids.add(id);
    }
  }
  for (const id of selectionEditedRelationshipsForSubject(store, view, entityId, sourceTypes)) ids.add(id);
  const missing = store.selectionRelationshipIndex?.missing;
  if (missing) {
    for (const id of [...(store.selectionRelationshipIndex?.exceptionalSubjects.get(entityId) ?? []), ...(store.selectionRelationshipIndex?.retryTypeRows ?? [])]) {
      // @raw-entity-enumeration-ok source class filters one exceptional relationship; its effective record is resolved by the caller
      const type = store.entityIndex.byId.get(id)?.type ?? '';
      if (sourceTypes.includes(type)) ids.add(id);
    }
  } else for (const type of sourceTypes) for (const id of legacyMissingRelationships(store).get(type) ?? []) ids.add(id);
  // The old inventory visited raw type buckets in source order, then retypes.
  // Graph adjacency orders targets instead; retain the original displayed order.
  return [...ids].sort((a, b) => {
    // @raw-entity-enumeration-ok source class and byte order preserve the historical display ordering of effective relationships
    const left = store.entityIndex.byId.get(a), right = store.entityIndex.byId.get(b);
    const rank = (type: string | undefined) => { const n = type ? sourceTypes.indexOf(type) : -1; return n < 0 ? sourceTypes.length : n; };
    return rank(left?.type) - rank(right?.type) || (left?.byteOffset ?? a) - (right?.byteOffset ?? b);
  });
}

const bursts = new WeakMap<object, Set<number>>();
/** A synchronous bulk loop may amortize a complete inventory. Separate UI
 * turns never accumulate toward this threshold, so the 33rd user click cannot
 * unexpectedly pay for the model. An existing bulk inventory remains reusable. */
export function useFullSelectionInventory(cache: { has(id: number): boolean } | undefined, subject: number | undefined): boolean {
  if (!cache) return subject === undefined;
  if (cache.has(-1) || subject === undefined) return true;
  let seen = bursts.get(cache);
  if (!seen) {
    seen = new Set(); bursts.set(cache, seen);
    const current = seen;
    queueMicrotask(() => { bursts.delete(cache); current.clear(); });
  }
  seen.add(subject);
  return seen.size >= 32;
}

export function selectionRelationshipCacheKey(store: IfcDataStore, view: SelectionEditView, subject: number | undefined,
  cache: { has(id: number): boolean } | undefined, primary = subject): number {
  if (subject === undefined || !store.source?.length || store.relationshipsPending
    || !store.relationships?.forward?.edgeRelIds || typeof store.relationships.inverse?.getEdges !== 'function'
    || (!view.getAttributeOverrideEntityIds && !view.getEffectiveChanges)) return -1;
  return useFullSelectionInventory(cache, primary) ? -1 : subject;
}
