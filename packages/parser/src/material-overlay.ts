/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Effective native material records and assignments, shared by all material readers (#7119). */
import { RelationshipType, type IfcAttributeValue, type EffectiveEntityOverlay, type IfcEntity } from '@ifc-lite/data';
import { EntityExtractor } from './entity-extractor.js';
import { parsedWriteValue } from './property-value-parser.js';
import { resolveOwnMaterialDefIds } from './material-associations.js';
import type { IfcDataStore } from './columnar-parser.js';
import { resolveEffectiveEntityRecord, type EffectiveEntityRecord } from './effective-entity-record.js';
import { resolveEffectiveRelationshipOverlay } from './effective-relationship-overlay.js';

export interface MaterialReadView extends EffectiveEntityOverlay {
  getNewEntities(): ReadonlyArray<{ readonly expressId: number; readonly type: string; readonly attributes?: readonly unknown[] }>;
  getNewEntity?(id: number): { readonly type: string; readonly attributes?: readonly unknown[] } | null;
  getPositionalMutationsForEntity?(id: number): ReadonlyMap<number, unknown> | null;
  getAttributeMutationsForEntity?(id: number): ReadonlyArray<{ name: string; value: string }>;
  getMutationRevision?(): number;
  getEffectiveChanges?(): ReadonlyArray<{ entityId: number; type: string }>;
  resolveBaseEntityId?(id: number): number;
}
export type MaterialRecordReader = (id: number) => EffectiveEntityRecord | null;
const records = new WeakMap<IfcDataStore, WeakMap<MaterialReadView, { revision: number; rows: Map<number, EffectiveEntityRecord | null> }>>();

/** Source-empty accessors may retain closures over bytes the transport did not supply. */
export function materialRecordReader(store: IfcDataStore, view?: MaterialReadView | null): MaterialRecordReader {
  const extractor = new EntityExtractor(store.source);
  const revision = view?.getMutationRevision?.();
  let model = records.get(store);
  if (!model) { model = new WeakMap(); records.set(store, model); }
  let memo = view && revision !== undefined ? model.get(view) : undefined;
  if (view && revision !== undefined && memo?.revision !== revision) {
    memo = { revision, rows: new Map() }; model.set(view, memo);
  }
  return id => {
    if (view?.isDeleted(id)) return null;
    if (memo?.rows.has(id)) return memo.rows.get(id) ?? null;
    const created = view?.getNewEntity ? view.getNewEntity(id) : view?.getNewEntities().find(row => row.expressId === id);
    // Old source-backed store facades expose indexed bytes without a getEntity accessor.
    // @raw-entity-enumeration-ok point lookup of one requested material/property record
    const ref = store.entityIndex.byId.get(id) ?? store.deferredEntityIndex?.get(id);
    const source = !store.source?.length ? null : typeof store.getEntity === 'function'
      ? store.getEntity(id) : ref ? extractor.extractEntity(ref) : null;
    const base = created ?? source;
    if (!base?.attributes) return null;
    const row = resolveEffectiveEntityRecord({ type: base.type, attributes: base.attributes }, {
      retype: view?.getTypeMutations?.().get(id)?.newType,
      named: view?.getAttributeMutationsForEntity?.(id).map(edit => [edit.name, edit.value === '$' || edit.value === '*' ? null : edit.value] as const) ?? [],
      positional: view?.getPositionalMutationsForEntity?.(id) ?? [],
    }, store.schemaVersion);
    row.attributes = row.attributes.map(value => Array.isArray(value) ? value.map(member => parsedWriteValue(member as IfcAttributeValue)) : parsedWriteValue(value as IfcAttributeValue));
    memo?.rows.set(id, row);
    return row;
  };
}

interface Edges { own: Map<number, number[]>; types: Map<number, number[]>; unavailable: boolean }
const edgesCache = new WeakMap<IfcDataStore, WeakMap<MaterialReadView, { revision: number; data: Edges }>>();
const relTypes = ['IFCRELASSOCIATESMATERIAL', 'IFCRELDEFINESBYTYPE'];
function materialEdges(store: IfcDataStore, view: MaterialReadView): Edges {
  const revision = view.getMutationRevision?.();
  const cached = edgesCache.get(store)?.get(view);
  if (revision !== undefined && cached?.revision === revision) return cached.data;
  // Source relationship records feed the canonical schema-derived endpoint reader.
  // @raw-entity-enumeration-ok canonical effective relationship inventory once per model/view revision
  const ids = relTypes.flatMap(type => store.entityIndex.byType.get(type) ?? []);
  for (const [id, mutation] of view.getTypeMutations?.() ?? []) {
    const sourceType = store.entityIndex.byId.get(id)?.type ?? store.deferredEntityIndex?.get(id)?.type;
    if (relTypes.includes(mutation.newType.toUpperCase()) || (sourceType && relTypes.includes(sourceType.toUpperCase()))) ids.push(id);
  }
  const sourceAvailable = Boolean(store.source?.length);
  const overlay = resolveEffectiveRelationshipOverlay(sourceAvailable ? store : { ...store, getEntity: () => null }, {
    createdEntities: () => view.getNewEntities().filter(row => row.attributes !== undefined)
      .map(row => ({ ...row, attributes: [...row.attributes!] } as IfcEntity)),
    mutatedEntityIds: () => ids,
    namedAttributes: id => view.getAttributeMutationsForEntity?.(id).map(edit => [edit.name, edit.value] as const) ?? [],
    positionalAttributes: id => view.getPositionalMutationsForEntity?.(id) as ReadonlyMap<number, IfcEntity['attributes'][number]> ?? [],
    entityType: id => view.getTypeMutations?.().get(id)?.newType,
    isDeleted: id => view.isDeleted(id),
  });
  const own = new Map<number, number[]>(), types = new Map<number, number[]>();
  for (const relation of [...overlay.relationships].sort((a, b) => a.relationshipId - b.relationshipId)) {
    const target = relation.relationshipType.toUpperCase() === relTypes[0] ? own
      : relation.relationshipType.toUpperCase() === relTypes[1] ? types : null;
    if (!target) continue;
    for (const recipient of relation.related) {
      if (view.isDeleted(recipient)) continue;
      const values = target.get(recipient) ?? [];
      for (const id of relation.relating) if (!view.isDeleted(id) && !values.includes(id)) values.push(id);
      target.set(recipient, values);
    }
  }
  const relevant = new Set(ids);
  const unavailable = !sourceAvailable && (view.getEffectiveChanges?.().some(edit => relevant.has(edit.entityId))
    ?? ids.some(id => view.isDeleted(id) || Boolean(view.getAttributeMutationsForEntity?.(id).length) || Boolean(view.getPositionalMutationsForEntity?.(id)?.size)));
  const data = { own, types, unavailable };
  if (revision !== undefined) {
    let model = edgesCache.get(store); if (!model) { model = new WeakMap(); edgesCache.set(store, model); }
    model.set(view, { revision, data });
  }
  return data;
}

/** Known full membership requires a graph, or a proven overriding occurrence list. */
export function materialAssignmentState(store: IfcDataStore, entityId: number, view?: MaterialReadView | null) {
  const baseId = view?.resolveBaseEntityId?.(entityId) ?? entityId;
  const subjects = [...new Set([baseId, entityId])];
  const current = view ? materialEdges(store, view) : null;
  const hasSource = Boolean(store.source?.length);
  const original = (id: number, kind: 'own' | 'types'): number[] => {
    return kind === 'own' ? resolveOwnMaterialDefIds(store, id)
      : store.relationships?.getRelated(id, RelationshipType.DefinesByType, 'inverse') ?? [];
  };
  const read = (id: number, kind: 'own' | 'types') => {
    const edited = current?.[kind].get(id) ?? [];
    if (current && hasSource) return edited;
    return [...new Set([...original(id, kind), ...edited])];
  };
  let ownerId = baseId, defIds = [...new Set(subjects.flatMap(id => read(id, 'own')))];
  if (!defIds.length) {
    for (const typeId of subjects.flatMap(id => read(id, 'types'))) {
      const associated = read(typeId, 'own');
      if (associated.length) { ownerId = typeId; defIds = associated; break; }
    }
  }
  const known = Boolean(store.relationships) || subjects.some(id => (store.onDemandMaterialMap?.get(id)?.length ?? 0) > 0)
    || Boolean(current && hasSource);
  return { ownerId, defIds, complete: known && !current?.unavailable };
}

/** Whether the supplied model can prove the selected element’s complete material membership. */
export function materialAssignmentsAvailable(store: IfcDataStore, entityId: number, view?: MaterialReadView | null): boolean {
  return materialAssignmentState(store, entityId, view).complete;
}
