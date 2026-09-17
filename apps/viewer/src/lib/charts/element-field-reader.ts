/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reads one IFC attribute or property per element for the charts (#4833),
 * over the model's parse plus its mutation overlay. Occurrence values win;
 * a property the occurrence lacks falls back to its defining type
 * (IfcRelDefinesByType); an explicit null or a deleted property stays missing
 * and suppresses that fallback. Everything is cached per element/type, so a
 * dataset pass over thousands of elements parses each pset once.
 */
import type { CellValue, ElementFieldBinding, NormalizedElementFieldValue } from '@ifc-lite/charts';
import { normalizeElementFieldValue } from '@ifc-lite/charts';
import type { IfcDataStore } from '@ifc-lite/parser';
import { getRawNamedAttributes } from '@ifc-lite/parser';
import { PropertyValueType, RelationshipType, type Property, type PropertySet } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { findPropertyInSets } from '@ifc-lite/query';
import { createListDataProvider } from '@/lib/lists/adapter';
import { createElementAttributeSchema } from './element-field-schema';
import {
  catalogFromObservations, emptyObservation, emptyObservations, observeAttribute, observeProperty, propertyObservationKey,
  type ElementFieldCatalog, type ElementFieldObservations,
} from './element-field-discovery';

export type { ElementFieldCatalog, ElementFieldOption } from './element-field-discovery';

/** Attributes the columnar entity table resolves itself — always text, so always scalar. */
const TABLE_ATTRIBUTES = ['GlobalId', 'Name', 'Description', 'ObjectType', 'Tag', 'PredefinedType'] as const;

function tableAttributeValue(store: IfcDataStore, expressId: number, name: string): unknown {
  switch (name) {
    case 'GlobalId': return store.entities.getGlobalId(expressId);
    case 'Name': return store.entities.getName(expressId);
    case 'Description': return store.entities.getDescription(expressId);
    case 'ObjectType': return store.entities.getObjectType(expressId);
    case 'Tag': return store.entities.getTag?.(expressId);
    case 'PredefinedType': return store.entities.getPredefinedType?.(expressId);
    default: return undefined;
  }
}

/** A read with the provenance the dataset needs to convert it: the property's explicit unit and declared measure. */
export type ResolvedElementFieldValue = NormalizedElementFieldValue & { unit?: string; unitSiScale?: number; dataType?: string };

export interface ElementFieldReader {
  read(expressId: number, binding: ElementFieldBinding): CellValue;
  readResolved(expressId: number, binding: ElementFieldBinding): ResolvedElementFieldValue;
  /** The value shapes these elements expose, mergeable across chunks and models. */
  observe(expressIds: readonly number[]): ElementFieldObservations;
  /** `catalogFromObservations(observe(ids))` — one model's catalog. */
  discover(expressIds: readonly number[]): ElementFieldCatalog;
}

const UNSUPPORTED: ResolvedElementFieldValue = { value: null, status: 'unsupported' };

/** Cached model-local reader. Recreate it when the store or mutation revision changes. */
export function createElementFieldReader(store: IfcDataStore, mutationView?: MutablePropertyView): ElementFieldReader {
  const provider = createListDataProvider(store);
  const schema = createElementAttributeSchema(store);
  const attributes = new Map<number, Map<string, unknown>>();
  const occurrenceSets = new Map<number, PropertySet[]>();
  const typeSets = new Map<number, PropertySet[]>();
  const typeIds = new Map<number, number>();
  const registeredVersion = store.schemaVersion === 'IFC5' ? undefined : store.schemaVersion;

  const isScalar = (typeName: string, attributeName: string): boolean =>
    (TABLE_ATTRIBUTES as readonly string[]).includes(attributeName) || schema.isScalarAttribute(typeName, attributeName);

  const definingTypeId = (id: number): number => {
    const cached = typeIds.get(id);
    if (cached !== undefined) return cached;
    const typeId = store.relationships?.getRelated(id, RelationshipType.DefinesByType, 'inverse')[0] ?? -1;
    typeIds.set(id, typeId);
    return typeId;
  };

  const attrsFor = (id: number): Map<string, unknown> => {
    let cached = attributes.get(id);
    if (cached) return cached;
    cached = new Map<string, unknown>();
    const entity = store.getEntity(id);
    if (entity) for (const { name, raw } of getRawNamedAttributes(entity, registeredVersion)) cached.set(name, raw);
    for (const name of TABLE_ATTRIBUTES) {
      const value = tableAttributeValue(store, id, name);
      if (value !== undefined && value !== '') cached.set(name, value);
    }
    for (const { name, value } of mutationView?.getAttributeMutationsForEntity(id) ?? []) cached.set(name, value);
    attributes.set(id, cached);
    return cached;
  };

  const setsFor = (id: number): PropertySet[] => {
    let cached = occurrenceSets.get(id);
    if (!cached) {
      cached = mutationView?.getForEntity(id) ?? provider.getPropertySets(id);
      occurrenceSets.set(id, cached);
    }
    return cached;
  };

  const typeSetsFor = (id: number): PropertySet[] => {
    const typeId = definingTypeId(id);
    if (typeId < 0) return [];
    let cached = typeSets.get(typeId);
    if (!cached) {
      cached = mutationView?.getForEntity(typeId) ?? provider.getTypePropertySets?.(id) ?? [];
      typeSets.set(typeId, cached);
    }
    return cached;
  };

  const propertyFor = (id: number, psetName: string, propertyName: string): Property | undefined => {
    const mutation = mutationView?.getPropertyMutation(id, psetName, propertyName);
    if (mutation?.operation === 'DELETE') {
      return { name: propertyName, type: PropertyValueType.String, value: null };
    }
    const occurrence = findPropertyInSets(setsFor(id), psetName, propertyName);
    // A present null/empty occurrence is authoritative and suppresses type fallback.
    if (occurrence) return occurrence;
    const typeId = definingTypeId(id);
    const typeMutation = typeId < 0 ? undefined : mutationView?.getPropertyMutation(typeId, psetName, propertyName);
    if (typeMutation?.operation === 'DELETE') return { name: propertyName, type: PropertyValueType.String, value: null };
    return findPropertyInSets(typeSetsFor(id), psetName, propertyName);
  };

  const readResolved = (id: number, binding: ElementFieldBinding): ResolvedElementFieldValue => {
    if (binding.kind === 'attribute') {
      const typeName = store.entities.getTypeName(id);
      const raw = attrsFor(id).get(binding.attributeName);
      // A reference or collection attribute is never a value, whatever its slot holds (#4833).
      if (raw !== undefined && !isScalar(typeName, binding.attributeName)) return UNSUPPORTED;
      const dataType = binding.dataType ?? schema.attributeType(typeName, binding.attributeName);
      return { ...normalizeElementFieldValue(raw, binding.valueKind), ...(dataType ? { dataType } : {}) };
    }
    const property = propertyFor(id, binding.psetName, binding.propertyName);
    const provenance = {
      ...(property?.unit ? { unit: property.unit } : {}),
      ...(property?.unitSiScale !== undefined ? { unitSiScale: property.unitSiScale } : {}),
      ...(property?.dataType ? { dataType: property.dataType } : {}),
    };
    if (property?.values) {
      // Enumerated / list / bounded / table: a shape, not a scalar. Its joined
      // display string is a category (unit-qualified like any other category);
      // it is never a number or a boolean.
      if (binding.valueKind !== 'category') return UNSUPPORTED;
      return { ...normalizeElementFieldValue(typeof property.value === 'string' ? property.value : null, 'category'), ...provenance };
    }
    return { ...normalizeElementFieldValue(property?.value, binding.valueKind), ...provenance };
  };

  const observe = (expressIds: readonly number[]): ElementFieldObservations => {
    const observations = emptyObservations();
    const seenTypes = new Set<string>();
    const ingest = (sets: readonly PropertySet[]): void => {
      for (const set of sets) for (const property of set.properties) {
        if (!set.name || !property.name) continue;
        const key = propertyObservationKey(set.name, property.name);
        let entry = observations.properties.get(key);
        if (!entry) {
          entry = { psetName: set.name, propertyName: property.name, kind: emptyObservation() };
          observations.properties.set(key, entry);
        }
        observeProperty(entry.kind, property);
      }
    };
    for (const id of expressIds) {
      const typeName = store.entities.getTypeName(id);
      if (!seenTypes.has(typeName)) {
        seenTypes.add(typeName);
        for (const name of schema.attributeNames(typeName)) {
          if (isScalar(typeName, name) && !observations.attributes.has(name)) observations.attributes.set(name, emptyObservation());
        }
      }
      for (const [name, raw] of attrsFor(id)) {
        if (!isScalar(typeName, name)) continue;
        let kind = observations.attributes.get(name);
        if (!kind) { kind = emptyObservation(); observations.attributes.set(name, kind); }
        observeAttribute(kind, raw, schema.attributeType(typeName, name));
      }
      ingest(setsFor(id));
      ingest(typeSetsFor(id));
    }
    return observations;
  };

  return {
    read: (id, binding) => readResolved(id, binding).value,
    readResolved,
    observe,
    discover: (expressIds) => catalogFromObservations(observe(expressIds)),
  };
}
