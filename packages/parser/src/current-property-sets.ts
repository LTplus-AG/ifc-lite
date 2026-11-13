/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { PropertyValueType, RelationshipType, type PropertySet } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { EntityExtractor } from './entity-extractor.js';
import type { MetadataReadView } from './effective-metadata-record.js';
import { extractPsetsFromIds, type TypePropertyInfo } from './on-demand-extractors.js';
import { propertyDefinitionRefsOfValue } from './property-definition-refs.js';
import { propertyRecord, propertyReference, type PropertyReadView } from './current-property-record.js';
import { appendSetsFromSecondSource, setIdentityKey } from './property-set-merge.js';
import { getEntityRefFromStore } from './columnar-parser-root-attributes.js';
import { getInheritanceChain } from './ifc-schema.js';

const MAX_PROPERTY_REFERENCES = 262_144;
type Sets = TypePropertyInfo['properties'];

function relations(store: IfcDataStore, view: PropertyReadView, subject: number, type: string, edge: RelationshipType): number[] {
  const candidates = new Set<number>();
  for (const row of store.relationships?.inverse.getEdges(subject, edge) ?? []) {
    candidates.add(row.relationshipId);
    for (const shadowed of row.shadowedRelationshipIds ?? []) candidates.add(shadowed);
  }
  const created = view.getNewEntitiesReferencing?.(subject) ?? view.getNewEntities();
  const retypes = view.getTypeMutations?.();
  for (const row of created) if ((retypes?.get(row.expressId)?.newType ?? row.type).toUpperCase() === type) candidates.add(row.expressId);
  for (const id of view.getAttributeOverrideEntityIds?.([type], subject) ?? []) candidates.add(id);
  // Source relationship order is the source map's order; it decides which
  // same-named set claims an ordinary property edit. Authored ids follow it.
  return [...candidates].sort((a, b) => {
    const left = getEntityRefFromStore(store, a)?.byteOffset ?? Infinity;
    const right = getEntityRefFromStore(store, b)?.byteOffset ?? Infinity;
    return left === right ? a - b : left - right;
  }).filter(id => {
    const row = propertyRecord(store, id, view);
    return row?.type.toUpperCase() === type && Array.isArray(row.attributes[4])
      && row.attributes[4].some(value => propertyReference(value) === subject);
  });
}

function definitions(store: IfcDataStore, id: number, view: PropertyReadView): { own: number[]; related: number[]; type: boolean } {
  const record = propertyRecord(store, id, view);
  if (!record) return { own: [], related: [], type: false };
  const type = getInheritanceChain(record.type).includes('IfcTypeObject');
  let references = 0;
  const refs = (value: unknown) => propertyDefinitionRefsOfValue(value, member => {
    if (++references > MAX_PROPERTY_REFERENCES) throw new RangeError('Property definition references exceed the read limit');
    return propertyReference(member);
  });
  const own = type ? refs(record.attributes[5]) : [];
  const related: number[] = [];
  for (const rel of relations(store, view, id, 'IFCRELDEFINESBYPROPERTIES', RelationshipType.DefinesByProperties)) {
    related.push(...refs(propertyRecord(store, rel, view)?.attributes[5]));
  }
  return { own, related, type };
}

/** Preserve source-only extraction; opt-in views read current raw records. */
export function readPropertySets(store: IfcDataStore, id: number, view?: MetadataReadView, occurrenceId = id): Sets {
  if (!view) {
    if (!store.onDemandPropertyMap || !store.source.length) return store.properties.getForEntity(id);
    return extractPsetsFromIds(store, new EntityExtractor(store.source), store.onDemandPropertyMap.get(id) ?? []);
  }
  const defs = definitions(store, occurrenceId, view);
  const related = new Set(defs.related);
  if (id !== occurrenceId) {
    // An alias inherits the immutable source baseline, not sets assigned to
    // the original after the copy was made. Its own live relations come first.
    for (const source of store.onDemandPropertyMap?.get(id) ?? []) related.add(source);
  }
  const extractor = new EntityExtractor(store.source);
  const ownIds = new Set(defs.own);
  const result = defs.type ? extractPsetsFromIds(store, extractor, [...ownIds], view)
    : extractPsetsFromIds(store, extractor, [...related], view);
  if (defs.type) appendSetsFromSecondSource(result, ownIds, new Set(result.map(setIdentityKey)), [...related],
    ids => extractPsetsFromIds(store, extractor, ids, view));
  if (!store.source.length) {
    // A table-backed model has no source record to resolve. Preserve its
    // saved definitions alongside raw authored sets; a current raw definition
    // with that saved identity takes precedence.
    const current = new Set(result.map(setIdentityKey));
    return [...store.properties.getForEntity(id).filter(set => !current.has(setIdentityKey(set))), ...result];
  }
  return result;
}

function baseSets(sets: Sets): PropertySet[] {
  return sets.map(set => ({ ...set, globalId: set.globalId ?? '', properties: set.properties.map(prop => ({ ...prop, type: prop.type as PropertyValueType })) }));
}

/** Current assignment, raw HasPropertySets, and ordinary property edits share one read. */
export function readTypeProperties(store: IfcDataStore, id: number, view: PropertyReadView): TypePropertyInfo | null {
  if (view.isDeleted(id)) return null;
  const relation = relations(store, view, id, 'IFCRELDEFINESBYTYPE', RelationshipType.DefinesByType)[0];
  const typeId = relation === undefined ? null : propertyReference(propertyRecord(store, relation, view)?.attributes[5]);
  if (typeId === null) return null;
  const type = propertyRecord(store, typeId, view);
  if (!type || !getInheritanceChain(type.type).includes('IfcTypeObject')) return null;
  const properties = view.getForEntity
    ? view.getForEntity(typeId, baseId => baseSets(readPropertySets(store, baseId, view, typeId)))
    : readPropertySets(store, typeId, view);
  if (properties.length === 0) return null;
  return { typeId, typeName: typeof type.attributes[2] === 'string' ? type.attributes[2] : type.type.toUpperCase(), properties };
}
