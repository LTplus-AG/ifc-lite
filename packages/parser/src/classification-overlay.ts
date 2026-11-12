/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Model-local classification inputs as the native edit session will export (#7131). */
import { iterateEffectiveEntities, RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { selectionRelationshipIds, selectionRelationshipCacheKey } from './selection-relationship-ids.js';
import { selectionRelationshipOverlay, selectedRelationshipMembers } from './selection-relationship-overlay.js';

export type { MetadataReadView as ClassificationReadView } from './effective-metadata-record.js';
import { effectiveMetadataRecord as classificationRecord, type MetadataReadView as ClassificationReadView } from './effective-metadata-record.js';
export { classificationRecord };

interface ClassificationEdges {
  references: Map<number, number[]>;
  types: Map<number, number[]>;
  unresolvedSource: boolean;
}
const cache = new WeakMap<IfcDataStore, WeakMap<ClassificationReadView, { revision: number; edges: Map<number | undefined, ClassificationEdges> }>>();

/** Build all association/type edges once per model overlay revision; no per-element relationship scan. */
export function classificationEdges(store: IfcDataStore, view: ClassificationReadView, entityId?: number, primaryId = entityId): ClassificationEdges {
  const revision = view.getMutationRevision();
  const cached = cache.get(store)?.get(view);
  const cacheKey = selectionRelationshipCacheKey(store, view, entityId, cached?.revision === revision ? cached.edges : undefined, primaryId);
  if (cached?.revision === revision && cached.edges.has(cacheKey)) return cached.edges.get(cacheKey)!;
  const relationTypes = ['IFCRELASSOCIATESCLASSIFICATION', 'IFCRELDEFINESBYTYPE'];
  // @raw-entity-enumeration-ok source relationship ids feed the canonical effective relationship reader; it applies deletion, edits and retypes
  const sourceIds = (cacheKey === -1 ? null : selectionRelationshipIds(store, view, entityId, [RelationshipType.AssociatesClassification, RelationshipType.DefinesByType], relationTypes))
    ?? relationTypes.flatMap(type => store.entityIndex.byType.get(type) ?? []);
  for (const id of view.getTypeMutations?.().keys() ?? []) sourceIds.push(id);
  const overlay = selectionRelationshipOverlay(store.source?.length ? store : { ...store, getEntity: () => null }, view, {
    createdEntities: () => view.getNewEntities(),
    mutatedEntityIds: () => sourceIds,
    namedAttributes: id => view.getAttributeMutationsForEntity(id).map(row => [row.name, row.value] as const),
    positionalAttributes: id => view.getPositionalMutationsForEntity(id) ?? [],
    entityType: id => view.getTypeMutations?.().get(id)?.newType,
    isDeleted: id => view.isDeleted(id),
  });
  // A source-empty transport does not carry enough attributes to reconstruct
  // edited source associations or chains. Preserve uncertainty instead of
  // treating the original forwarded rows as effective live data.
  const unresolvedSource = !store.source?.length && [...sourceIds,
    // @raw-entity-enumeration-ok source definition/reference ids are inspected only for live edits when their bytes are unavailable
    ...(store.entityIndex.byType.get('IFCCLASSIFICATION') ?? []), ...(store.entityIndex.byType.get('IFCCLASSIFICATIONREFERENCE') ?? [])]
    .some(id => view.isDeleted(id)
    || view.getTypeMutations?.().has(id) || view.getAttributeMutationsForEntity(id).length > 0
    || (view.getPositionalMutationsForEntity(id)?.size ?? 0) > 0);
  const edges: ClassificationEdges = { references: new Map(), types: new Map(), unresolvedSource };
  for (const relation of overlay.relationships) {
    const upper = relation.relationshipType.toUpperCase();
    const index = upper === relationTypes[0] ? edges.references : upper === relationTypes[1] ? edges.types : null;
    if (!index) continue;
    for (const related of selectedRelationshipMembers(relation, entityId, cacheKey === -1)) {
      if (view.isDeleted(related)) continue;
      const values = index.get(related) ?? [];
      for (const target of relation.relating) if (!view.isDeleted(target) && !values.includes(target)) values.push(target);
      index.set(related, values);
    }
  }
  let modelCache = cache.get(store);
  if (!modelCache) { modelCache = new WeakMap(); cache.set(store, modelCache); }
  const rows = cached?.revision === revision ? cached.edges : new Map<number | undefined, ClassificationEdges>();
  rows.set(cacheKey, edges);
  modelCache.set(view, { revision, edges: rows });
  return edges;
}

export function classificationSystemIds(store: IfcDataStore, view: ClassificationReadView): number[] {
  return [...iterateEffectiveEntities(store, view, ['IFCCLASSIFICATION'])].map(entity => entity.expressId);
}
