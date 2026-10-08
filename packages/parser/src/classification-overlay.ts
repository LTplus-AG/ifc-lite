/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Model-local classification inputs as the native edit session will export (#7131). */
import { iterateEffectiveEntities, type EffectiveEntityOverlay, type IfcAttributeValue } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { resolveEffectiveEntityRecord, type EffectiveEntityRecord } from './effective-entity-record.js';
import { resolveEffectiveRelationshipOverlay } from './effective-relationship-overlay.js';

export interface ClassificationReadView extends EffectiveEntityOverlay {
  getNewEntities(): ReadonlyArray<{ readonly expressId: number; readonly type: string; readonly attributes: IfcAttributeValue[] }>;
  getNewEntity(expressId: number): { readonly type: string; readonly attributes: IfcAttributeValue[] } | null;
  getPositionalMutationsForEntity(expressId: number): ReadonlyMap<number, IfcAttributeValue> | null;
  getAttributeMutationsForEntity(expressId: number): ReadonlyArray<{ name: string; value: string }>;
  getMutationRevision(): number;
  resolveBaseEntityId?(expressId: number): number;
}

const records = new WeakMap<IfcDataStore, WeakMap<ClassificationReadView, { revision: number; rows: Map<number, EffectiveEntityRecord | null> }>>();
// Native edited/created STEP markers denote absent/derived values. Do not
// normalize source strings: a quoted '$' in the original file is literal text.
const editValue = (value: unknown): unknown => value === '$' || value === '*' ? null : value;

export function classificationRecord(store: IfcDataStore, expressId: number, view?: ClassificationReadView): EffectiveEntityRecord | null {
  if (view?.isDeleted(expressId)) return null;
  let modelRecords = records.get(store);
  if (!modelRecords) { modelRecords = new WeakMap(); records.set(store, modelRecords); }
  const revision = view?.getMutationRevision();
  let memo = view ? modelRecords.get(view) : undefined;
  if (view && memo?.revision !== revision) { memo = { revision: revision!, rows: new Map() }; modelRecords.set(view, memo); }
  if (memo?.rows.has(expressId)) return memo.rows.get(expressId) ?? null;
  const created = view?.getNewEntity(expressId);
  // Source-empty stores cannot reveal source attributes through a stale accessor closure.
  // Named/positional edits may still supply a known field on an otherwise unreadable row.
  const base = created ? { ...created, attributes: created.attributes.map(editValue) } : (store.source?.length ? store.getEntity(expressId) : {
    type: store.entities.getTypeName(expressId), attributes: [],
  });
  if (!base) return null;
  const result = resolveEffectiveEntityRecord(base, {
    retype: view?.getTypeMutations?.().get(expressId)?.newType,
    named: view?.getAttributeMutationsForEntity(expressId).map(row => [row.name, editValue(row.value)] as const) ?? [],
    positional: [...(view?.getPositionalMutationsForEntity(expressId) ?? [])].map(([index, value]) => [index, editValue(value)] as const),
  }, store.schemaVersion);
  memo?.rows.set(expressId, result);
  return result;
}

interface ClassificationEdges {
  references: Map<number, number[]>;
  types: Map<number, number[]>;
  unresolvedSource: boolean;
}
const cache = new WeakMap<IfcDataStore, WeakMap<ClassificationReadView, { revision: number; edges: ClassificationEdges }>>();

/** Build all association/type edges once per model overlay revision; no per-element relationship scan. */
export function classificationEdges(store: IfcDataStore, view: ClassificationReadView): ClassificationEdges {
  const revision = view.getMutationRevision();
  const cached = cache.get(store)?.get(view);
  if (cached?.revision === revision) return cached.edges;
  const relationTypes = ['IFCRELASSOCIATESCLASSIFICATION', 'IFCRELDEFINESBYTYPE'];
  // @raw-entity-enumeration-ok source relationship ids feed the canonical effective relationship reader; it applies deletion, edits and retypes
  const sourceIds = relationTypes.flatMap(type => store.entityIndex.byType.get(type) ?? []);
  for (const id of view.getTypeMutations?.().keys() ?? []) sourceIds.push(id);
  const overlay = resolveEffectiveRelationshipOverlay(store.source?.length ? store : { ...store, getEntity: () => null }, {
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
  const unknownSourceIds = [...sourceIds,
    // @raw-entity-enumeration-ok source definition/reference ids are inspected only for live edits when their bytes are unavailable
    ...(store.entityIndex.byType.get('IFCCLASSIFICATION') ?? []), ...(store.entityIndex.byType.get('IFCCLASSIFICATIONREFERENCE') ?? [])];
  const unresolvedSource = !store.source?.length && unknownSourceIds.some(id => view.isDeleted(id)
    || view.getTypeMutations?.().has(id) || view.getAttributeMutationsForEntity(id).length > 0
    || (view.getPositionalMutationsForEntity(id)?.size ?? 0) > 0);
  const edges: ClassificationEdges = { references: new Map(), types: new Map(), unresolvedSource };
  for (const relation of overlay.relationships) {
    const upper = relation.relationshipType.toUpperCase();
    const index = upper === relationTypes[0] ? edges.references : upper === relationTypes[1] ? edges.types : null;
    if (!index) continue;
    for (const related of relation.related) {
      if (view.isDeleted(related)) continue;
      const values = index.get(related) ?? [];
      for (const target of relation.relating) if (!view.isDeleted(target) && !values.includes(target)) values.push(target);
      index.set(related, values);
    }
  }
  let modelCache = cache.get(store);
  if (!modelCache) { modelCache = new WeakMap(); cache.set(store, modelCache); }
  modelCache.set(view, { revision, edges });
  return edges;
}

export function classificationSystemIds(store: IfcDataStore, view: ClassificationReadView): number[] {
  return [...iterateEffectiveEntities(store, view, ['IFCCLASSIFICATION'])].map(entity => entity.expressId);
}
