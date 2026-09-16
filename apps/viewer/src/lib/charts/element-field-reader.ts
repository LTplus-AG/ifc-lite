/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CellValue, ElementFieldBinding, ElementFieldValueKind, NormalizedElementFieldValue } from '@ifc-lite/charts';
import { normalizeElementFieldValue } from '@ifc-lite/charts';
import type { IfcDataStore, SchemaRegistry } from '@ifc-lite/parser';
import { getAttributeNamesAcrossSchemas, getRawNamedAttributes, getSchemaRegistryForVersion, measureUnit } from '@ifc-lite/parser';
import { PropertyValueType, RelationshipType, type Property, type PropertySet } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { findPropertyInSets } from '@ifc-lite/query';
import { createListDataProvider } from '@/lib/lists/adapter';

export interface ElementFieldOption {
  binding: ElementFieldBinding;
  label: string;
}

export interface ElementFieldCatalog {
  attributes: ElementFieldOption[];
  properties: Map<string, ElementFieldOption[]>;
}

interface ObservedKind {
  text: boolean;
  number: boolean;
  boolean: boolean;
  units: Set<string>;
  dataTypes: Set<string>;
}

function inferKind(observed: ObservedKind): ElementFieldValueKind {
  if (observed.number && !observed.text && !observed.boolean) {
    const unitTypes = new Set<string>();
    let allTypedMeasures = observed.dataTypes.size > 0;
    for (const dataType of observed.dataTypes) {
      const measure = measureUnit(dataType);
      if (measure?.kind === 'typed') unitTypes.add(measure.unitType);
      else allTypedMeasures = false;
    }
    const compatibleMeasures = allTypedMeasures && unitTypes.size === 1;
    if (observed.dataTypes.size > 1 && !compatibleMeasures) return 'category';
    if (observed.units.size > 1 && !compatibleMeasures) return 'category';
    return 'number';
  }
  if (observed.boolean && !observed.text && !observed.number) return 'boolean';
  return 'category';
}

function observe(observed: ObservedKind, property: Property): void {
  if (property.values) return;
  const normalized = normalizeElementFieldValue(property.value, typeof property.value === 'number' ? 'number' : typeof property.value === 'boolean' ? 'boolean' : 'category');
  if (normalized.status !== 'value') return;
  if (typeof normalized.value === 'number') observed.number = true;
  else if (typeof normalized.value === 'boolean') observed.boolean = true;
  else observed.text = true;
  if (property.unit) observed.units.add(property.unit);
  if (property.dataType) observed.dataTypes.add(property.dataType.toUpperCase());
}

function observeRaw(observed: ObservedKind, raw: unknown, declaredType?: string): void {
  if (declaredType) observed.dataTypes.add(declaredType.toUpperCase());
  if (Array.isArray(raw) && raw.length === 2 && typeof raw[0] === 'string' && raw[0].toUpperCase().startsWith('IFC')) {
    observed.dataTypes.add(raw[0].toUpperCase());
  }
  const numeric = normalizeElementFieldValue(raw, 'number');
  const logical = normalizeElementFieldValue(raw, 'boolean');
  const normalized = numeric.status === 'value'
    ? numeric
    : logical.status === 'value'
      ? logical
      : normalizeElementFieldValue(raw, 'category');
  if (normalized.status !== 'value') return;
  if (typeof normalized.value === 'number') observed.number = true;
  else if (typeof normalized.value === 'boolean') observed.boolean = true;
  else observed.text = true;
}

function emptyObservation(): ObservedKind {
  return { text: false, number: false, boolean: false, units: new Set(), dataTypes: new Set() };
}

function rawAttributeValue(store: IfcDataStore, expressId: number, name: string): unknown {
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

export interface ElementFieldReader {
  read(expressId: number, binding: ElementFieldBinding): CellValue;
  readResolved(expressId: number, binding: ElementFieldBinding): NormalizedElementFieldValue & { unit?: string; dataType?: string };
  discover(expressIds: readonly number[]): ElementFieldCatalog;
}

/** Cached model-local reader. Recreate it when the store or mutation revision changes. */
export function createElementFieldReader(store: IfcDataStore, mutationView?: MutablePropertyView): ElementFieldReader {
  const provider = createListDataProvider(store);
  const attributes = new Map<number, Map<string, unknown>>();
  const occurrenceSets = new Map<number, PropertySet[]>();
  const typeSets = new Map<number, PropertySet[]>();
  const typeIds = new Map<number, number>();
  const attributeTypes = new Map<string, Map<string, string>>();
  const schemaRegistry: SchemaRegistry | undefined = store.schemaVersion === 'IFC5'
    ? undefined
    : getSchemaRegistryForVersion(store.schemaVersion);

  const attributeTypeFor = (typeName: string, attributeName: string): string | undefined => {
    let byName = attributeTypes.get(typeName);
    if (!byName) {
      const direct = schemaRegistry?.entities[typeName];
      const metadata = direct ?? Object.values(schemaRegistry?.entities ?? {}).find((entity) => entity.name.toUpperCase() === typeName.toUpperCase());
      byName = new Map((metadata?.allAttributes ?? []).map((attribute) => [attribute.name, attribute.type]));
      attributeTypes.set(typeName, byName);
    }
    return byName.get(attributeName);
  };

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
    if (entity) for (const { name, raw } of getRawNamedAttributes(entity)) cached.set(name, raw);
    for (const name of ['GlobalId', 'Name', 'Description', 'ObjectType', 'Tag', 'PredefinedType']) {
      const value = rawAttributeValue(store, id, name);
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

  const readResolved = (id: number, binding: ElementFieldBinding): NormalizedElementFieldValue & { unit?: string; dataType?: string } => {
    if (binding.kind === 'attribute') {
      const dataType = binding.dataType ?? attributeTypeFor(store.entities.getTypeName(id), binding.attributeName);
      return { ...normalizeElementFieldValue(attrsFor(id).get(binding.attributeName), binding.valueKind), ...(dataType ? { dataType } : {}) };
    }
    const property = propertyFor(id, binding.psetName, binding.propertyName);
    if (property?.values) return { value: null, status: 'unsupported' };
    const normalized = normalizeElementFieldValue(property?.value, binding.valueKind);
    const value = binding.valueKind === 'category'
      && normalized.status === 'value'
      && typeof normalized.value === 'string'
      && (property?.unit || property?.dataType)
      && (typeof property.value === 'number' || (Array.isArray(property.value) && typeof property.value[1] === 'number'))
      ? `${normalized.value} ${property.unit ?? property.dataType}`
      : normalized.value;
    return { ...normalized, value, ...(property?.unit ? { unit: property.unit } : {}), ...(property?.dataType ? { dataType: property.dataType } : {}) };
  };

  return {
    read(id, binding) {
      return readResolved(id, binding).value;
    },
    readResolved,

    discover(expressIds) {
      const attributeNames = new Set<string>();
      const attributeKinds = new Map<string, ObservedKind>();
      const observed = new Map<string, { psetName: string; propertyName: string; kind: ObservedKind }>();
      const seenTypes = new Set<string>();
      const ingest = (sets: readonly PropertySet[]) => {
        for (const set of sets) for (const property of set.properties) {
          if (!set.name || !property.name) continue;
          const key = JSON.stringify([set.name, property.name]);
          let entry = observed.get(key);
          if (!entry) {
            entry = { psetName: set.name, propertyName: property.name, kind: emptyObservation() };
            observed.set(key, entry);
          }
          observe(entry.kind, property);
        }
      };
      for (const id of expressIds) {
        const typeName = store.entities.getTypeName(id);
        if (!seenTypes.has(typeName)) {
          seenTypes.add(typeName);
          for (const name of getAttributeNamesAcrossSchemas(typeName)) attributeNames.add(name);
        }
        for (const [name, raw] of attrsFor(id)) {
          let kind = attributeKinds.get(name);
          if (!kind) { kind = emptyObservation(); attributeKinds.set(name, kind); }
          observeRaw(kind, raw, attributeTypeFor(typeName, name));
        }
        ingest(setsFor(id));
        ingest(typeSetsFor(id));
      }
      const attributeOptions = [...attributeNames]
        .sort()
        .map((attributeName) => {
          const kind = attributeKinds.get(attributeName) ?? emptyObservation();
          const valueKind = inferKind(kind);
          const dataType = valueKind === 'number' && kind.dataTypes.size > 0 ? [...kind.dataTypes].sort()[0] : undefined;
          return { binding: { kind: 'attribute', attributeName, valueKind, ...(dataType ? { dataType } : {}) } as const, label: attributeName };
        });
      const properties = new Map<string, ElementFieldOption[]>();
      for (const { psetName, propertyName, kind } of observed.values()) {
        const valueKind = inferKind(kind);
        const unit = valueKind === 'number' && kind.units.size === 1 ? [...kind.units][0] : undefined;
        const dataType = valueKind === 'number' && kind.dataTypes.size > 0 ? [...kind.dataTypes].sort()[0] : undefined;
        const option: ElementFieldOption = {
          binding: { kind: 'property', psetName, propertyName, valueKind, ...(unit ? { unit } : {}), ...(dataType ? { dataType } : {}) },
          label: `${psetName}.${propertyName}`,
        };
        const bucket = properties.get(psetName) ?? [];
        bucket.push(option);
        properties.set(psetName, bucket);
      }
      for (const options of properties.values()) options.sort((a, b) => a.label.localeCompare(b.label));
      return { attributes: attributeOptions, properties: new Map([...properties].sort(([a], [b]) => a.localeCompare(b))) };
    },
  };
}
