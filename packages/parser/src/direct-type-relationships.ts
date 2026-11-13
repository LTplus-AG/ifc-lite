/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { effectiveMetadataRecord, type MetadataReadView } from './effective-metadata-record.js';
import { CurrentQuantityRefusal, MAX_RELATIONSHIPS, MAX_RELATION_REFERENCES, readRelation, type RelationRead, type CurrentTypeRelationships } from './current-type-relationships.js';
import { selectionRelationshipIds } from './selection-relationship-ids.js';
import { selectionRelationshipEditIds } from './selection-relationship-edits.js';
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
  const typeMutations = view.getTypeMutations?.();
  const changed = new Set([...selectionRelationshipEditIds(store, view), ...(view.getTombstones?.() ?? []), ...(typeMutations?.keys() ?? [])]);
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
  const dependencies = new Set<number>();
  for (const id of changed) {
    const type = sourceType(id);
    if (!type) continue;
    let definition = definitionClasses.get(type);
    if (definition === undefined) {
      definition = getInheritanceChain(normalizeIfcTypeName(type)).includes('IfcPropertySetDefinition');
      definitionClasses.set(type, definition);
    }
    const changedType = view.getNewEntity(id)?.type ?? typeMutations?.get(id)?.newType;
    const currentDefinition = changedType && getInheritanceChain(normalizeIfcTypeName(changedType)).includes('IfcPropertySetDefinition');
    if ((definition || currentDefinition) && (view.isDeleted(id) || changedType)) {
      const affectedRows = !definition && currentDefinition ? changed : dependencies;
      for (const row of index.exceptionalDefinitionTargets.get(id) ?? []) affectedRows.add(row);
      for (const edge of store.relationships.forward.getEdges(id, RelationshipType.DefinesByProperties)) {
        affectedRows.add(edge.relationshipId);
        for (const other of edge.shadowedRelationshipIds ?? []) affectedRows.add(other);
      }
    }
  }
  const reads = new Map<number, RelationRead | CurrentQuantityRefusal>();
  const sourceRecords = new Map<number, NonNullable<ReturnType<typeof effectiveMetadataRecord>>>();
  const memberships = new Map<number, Set<number>>();
  const editedBySubject = new Map<number, Set<number>>();
  const read = (id: number): RelationRead => {
    const cached = reads.get(id);
    if (cached instanceof CurrentQuantityRefusal) throw cached;
    if (reads.has(id)) return cached!;
    const type = typeMutations?.get(id)?.newType.toUpperCase() ?? view.getNewEntity(id)?.type.toUpperCase() ?? sourceType(id);
    try {
      const value = !view.isDeleted(id) && type && types.includes(type) ? readRelation(store, id, view, sourceRecords.get(id)) : null;
      reads.set(id, value);
      if (value) {
        const members = new Set(value.members);
        memberships.set(id, members);
        if (changed.has(id) || unverified.has(id)) for (const member of members) {
          const ids = editedBySubject.get(member) ?? new Set<number>();
          ids.add(id); editedBySubject.set(member, ids);
        }
      }
      return value;
    } catch (error) {
      // Domain refusals hold for the revision. Unexpected source errors retry.
      if (error instanceof CurrentQuantityRefusal) reads.set(id, error);
      throw error;
    }
  };
  for (const row of created) if (types.includes(row.type.toUpperCase()) || typeMutations?.has(row.expressId)) changed.add(row.expressId);
  const retyped = new Map([...typeMutations?.keys() ?? []].map((id, i) => [id, i]));
  const authored = new Map(created.map((row, i) => [row.expressId, i]));
  const rank = (id: number) => createdIds.has(id) ? 3 : types.includes(sourceType(id) ?? '') ? types.indexOf(sourceType(id)!) : 2;
  // @raw-entity-enumeration-ok source byte order ranks effective rows within their historical source bucket
  const order = (id: number) => authored.get(id) ?? retyped.get(id) ?? store.entityIndex.byId.get(id)?.byteOffset ?? 0;
  // @raw-entity-enumeration-ok source bucket order determines which malformed effective row supplies the refusal reason
  const compare = (a: number, b: number) => rank(a) - rank(b) ||
    (rank(a) < 2 ? (store.entityIndex.byId.get(a)?.byteOffset ?? 0) - (store.entityIndex.byId.get(b)?.byteOffset ?? 0) : order(a) - order(b));
  const affected = new Set([...unverified, ...changed, ...index.typeRefusals.keys()]);
  const contributions = [...affected].sort(compare).map(id => {
    const baseType = sourceType(id), base = baseType !== undefined && types.includes(baseType) && !createdIds.has(id);
    const currentType = typeMutations?.get(id)?.newType.toUpperCase() ?? view.getNewEntity(id)?.type.toUpperCase() ?? baseType;
    const current = !view.isDeleted(id) && currentType !== undefined && types.includes(currentType);
    rows += Number(current) - Number(base);
    return { id, base, current };
  });
  if (rows > MAX_RELATIONSHIPS) throw new CurrentQuantityRefusal(`Native type relationship inventory exceeds the read limit of ${MAX_RELATIONSHIPS} relationships`);
  const apply = ({ id, base, current }: { id: number; base: boolean; current: boolean }) => {
    if (!base && !current) return;
    const refusal = index.typeRefusals.get(id);
    if (refusal && !changed.has(id) && !view.isDeleted(id)) throw new CurrentQuantityRefusal(refusal);
    if (base && !unverified.has(id)) {
      if (index.typeExceptionalReferences.has(id)) references -= index.typeExceptionalReferences.get(id)!;
      else if (!index.typeRefusals.has(id)) {
        const sourceRecord = effectiveMetadataRecord(store, id, noEdits);
        if (sourceRecord) sourceRecords.set(id, sourceRecord);
        const old = readRelation(store, id, noEdits);
        if (old) references -= new Set(old.members).size * old.targets.length;
      }
    }
    const relation = read(id);
    if (relation) references += relation.members.length * relation.targets.length;
  };
  for (const contribution of contributions) apply(contribution);
  // Deleted/retyped definitions can only reduce untouched source coverage.
  // Its upper bound is sufficient until it crosses the budget, as in the native reader.
  if (references > MAX_RELATION_REFERENCES) for (const id of dependencies) {
    if (references <= MAX_RELATION_REFERENCES) break;
    if (affected.has(id)) continue;
    apply({ id, base: true, current: !view.isDeleted(id) });
  }
  if (rows > MAX_RELATIONSHIPS) throw new CurrentQuantityRefusal(`Native type relationship inventory exceeds the read limit of ${MAX_RELATIONSHIPS} relationships`);
  if (references > MAX_RELATION_REFERENCES) throw new CurrentQuantityRefusal(`Native type relationship references exceed the read limit of ${MAX_RELATION_REFERENCES} references`);

  const lookup = (kind: RelationshipType, type: string) => {
    const memo = new Map<number, readonly number[]>();
    return (subject: number): readonly number[] => {
      const old = memo.get(subject); if (old) return old;
      const candidates = new Set(selectionRelationshipIds(store, view, subject, [kind], [type], editedBySubject.get(subject) ?? []) ?? []);
      if (kind === RelationshipType.DefinesByProperties && store.relationshipsPending) {
        for (const id of index.typeDefinitions.get(subject) ?? []) candidates.add(id);
      }
      const contributions: Array<{ id: number; targets: number[] }> = [];
      for (const id of candidates) {
        const relation = read(id);
        if (relation && relation.byType === (kind === RelationshipType.DefinesByType) && memberships.get(id)?.has(subject)) {
          contributions.push({ id, targets: relation.targets });
        }
      }
      contributions.sort((a, b) => compare(a.id, b.id));
      const result = [...new Set(contributions.flatMap(row => row.targets))];
      memo.set(subject, result); return result;
    };
  };
  return { typesOf: lookup(RelationshipType.DefinesByType, types[0]), definitionsOf: lookup(RelationshipType.DefinesByProperties, types[1]) };
}
