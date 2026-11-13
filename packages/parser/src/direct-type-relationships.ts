/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { type MetadataReadView } from './effective-metadata-record.js';
import { CurrentQuantityRefusal, MAX_RELATIONSHIPS, MAX_RELATION_REFERENCES, readRelation, type RelationRead, type CurrentTypeRelationships } from './current-type-relationships.js';
import { selectionRelationshipIds } from './selection-relationship-ids.js';
import { getInheritanceChain, normalizeIfcTypeName } from './ifc-schema.js';

const types = ['IFCRELDEFINESBYTYPE', 'IFCRELDEFINESBYPROPERTIES'];
const noEdits: MetadataReadView = {
  isDeleted: () => false, getNewEntities: () => [], getNewEntity: () => null,
  getPositionalMutationsForEntity: () => null, getAttributeMutationsForEntity: () => [], getMutationRevision: () => 0,
};

/** The parser already counted the source rows while decoding their endpoints.
 * Only edits and exceptional unindexed rows can alter that aggregate coverage.
 * Ordinary selections follow incident edges, never enumerate the model. */
export function directCurrentTypeRelationships(store: IfcDataStore, view: MetadataReadView): CurrentTypeRelationships {
  const index = store.selectionRelationshipIndex!;
  let rows = index.typeRows, references = index.typeReferences;
  const unverified = new Set(index.retryTypeRows);
  const changed = new Set([...view.getAttributeOverrideEntityIds!(), ...(view.getTombstones?.() ?? [])]);
  const created = view.getNewEntities();
  const createdIds = new Set(created.map(row => row.expressId));
  for (const row of created) {
    for (const relationship of index.exceptionalDefinitionTargets.get(row.expressId) ?? []) changed.add(relationship);
  }
  const sourceType = (id: number) => {
    // @raw-entity-enumeration-ok source class for one candidate edit, not a model enumeration
    return (store.entityIndex.byId.get(id) ?? store.deferredEntityIndex?.get(id))?.type.toUpperCase();
  };
  const definitionClasses = new Map<string, boolean>();
  for (const id of changed) {
    const type = sourceType(id);
    if (!type) continue;
    let definition = definitionClasses.get(type);
    if (definition === undefined) {
      definition = getInheritanceChain(normalizeIfcTypeName(type)).includes('IfcPropertySetDefinition');
      definitionClasses.set(type, definition);
    }
    const changedType = view.getNewEntity(id)?.type ?? view.getTypeMutations?.().get(id)?.newType;
    const currentDefinition = changedType && getInheritanceChain(normalizeIfcTypeName(changedType)).includes('IfcPropertySetDefinition');
    if ((definition || currentDefinition) && (view.isDeleted(id) || changedType)) {
      for (const row of index.exceptionalDefinitionTargets.get(id) ?? []) changed.add(row);
      for (const edge of store.relationships.forward.getEdges(id, RelationshipType.DefinesByProperties)) {
        changed.add(edge.relationshipId);
        for (const other of edge.shadowedRelationshipIds ?? []) changed.add(other);
      }
    }
  }
  for (const [id, reason] of index.typeRefusals) {
    if (!changed.has(id) && !view.isDeleted(id)) throw new CurrentQuantityRefusal(reason);
  }
  const reads = new Map<number, RelationRead>();
  const memberships = new Map<number, Set<number>>();
  const read = (id: number): RelationRead => {
    if (reads.has(id)) return reads.get(id)!;
    const type = view.getNewEntity(id)?.type.toUpperCase() ?? view.getTypeMutations?.().get(id)?.newType.toUpperCase() ?? sourceType(id);
    const value = !view.isDeleted(id) && type && types.includes(type) ? readRelation(store, id, view) : null;
    // Unexpected errors deliberately leave no cached refusal: the next read retries.
    reads.set(id, value);
    if (value) memberships.set(id, new Set(value.members));
    return value;
  };
  for (const row of created) if (types.includes(row.type.toUpperCase()) || view.getTypeMutations?.().has(row.expressId)) changed.add(row.expressId);
  const affected = new Set([...unverified, ...changed]);
  const contributions = [...affected].map(id => {
    const baseType = sourceType(id), base = baseType !== undefined && types.includes(baseType) && !createdIds.has(id);
    const currentType = view.getNewEntity(id)?.type.toUpperCase() ?? view.getTypeMutations?.().get(id)?.newType.toUpperCase() ?? baseType;
    const current = !view.isDeleted(id) && currentType !== undefined && types.includes(currentType);
    rows += Number(current) - Number(base);
    return { id, base, current };
  });
  if (rows > MAX_RELATIONSHIPS) throw new CurrentQuantityRefusal(`Native type relationship inventory exceeds the read limit of ${MAX_RELATIONSHIPS} relationships`);
  for (const { id, base, current } of contributions) {
    if (!base && !current) continue;
    if (base && !unverified.has(id)) {
      if (index.typeExceptionalReferences.has(id)) references -= index.typeExceptionalReferences.get(id)!;
      else if (!index.typeRefusals.has(id)) {
        const old = readRelation(store, id, noEdits);
        if (old) references -= new Set(old.members).size * old.targets.length;
      }
    }
    const relation = read(id);
    if (relation) references += relation.members.length * relation.targets.length;
  }
  if (rows > MAX_RELATIONSHIPS) throw new CurrentQuantityRefusal(`Native type relationship inventory exceeds the read limit of ${MAX_RELATIONSHIPS} relationships`);
  if (references > MAX_RELATION_REFERENCES) throw new CurrentQuantityRefusal(`Native type relationship references exceed the read limit of ${MAX_RELATION_REFERENCES} references`);

  const lookup = (kind: RelationshipType, type: string) => {
    const memo = new Map<number, readonly number[]>();
    return (subject: number): readonly number[] => {
      const old = memo.get(subject); if (old) return old;
      const candidates = selectionRelationshipIds(store, view, subject, [kind], [type]) ?? [];
      if (kind === RelationshipType.DefinesByProperties && store.relationshipsPending) {
        for (const id of index.typeDefinitions.get(subject) ?? []) if (!candidates.includes(id)) candidates.push(id);
      }
      for (const id of changed) if (!candidates.includes(id)) candidates.push(id);
      const contributions: Array<{ id: number; targets: number[] }> = [];
      for (const id of candidates) {
        const relation = read(id);
        if (relation && relation.byType === (kind === RelationshipType.DefinesByType) && memberships.get(id)?.has(subject)) {
          contributions.push({ id, targets: relation.targets });
        }
      }
      const retyped = new Map([...view.getTypeMutations?.().keys() ?? []].map((id, i) => [id, i]));
      const authored = new Map(created.map((row, i) => [row.expressId, i]));
      const rank = (id: number) => createdIds.has(id) ? 3 : types.includes(sourceType(id) ?? '') ? types.indexOf(sourceType(id)!) : 2;
      const order = (id: number) => authored.get(id) ?? retyped.get(id) ?? store.entityIndex.byId.get(id)?.byteOffset ?? 0;
      contributions.sort((a, b) => rank(a.id) - rank(b.id) ||
        (rank(a.id) < 2 ? (store.entityIndex.byId.get(a.id)?.byteOffset ?? 0) - (store.entityIndex.byId.get(b.id)?.byteOffset ?? 0) : order(a.id) - order(b.id)));
      const result = [...new Set(contributions.flatMap(row => row.targets))];
      memo.set(subject, result); return result;
    };
  };
  return { typesOf: lookup(RelationshipType.DefinesByType, types[0]), definitionsOf: lookup(RelationshipType.DefinesByProperties, types[1]) };
}
