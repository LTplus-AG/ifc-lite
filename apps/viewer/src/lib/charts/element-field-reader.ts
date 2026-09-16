/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CellValue, ElementFieldBinding, ElementFieldValueKind } from '@ifc-lite/charts';
import { normalizeElementFieldValue } from '@ifc-lite/charts';
import type { IfcDataStore } from '@ifc-lite/parser';
import { getAttributeNamesAcrossSchemas, getRawNamedAttributes } from '@ifc-lite/parser';
import { PropertyValueType, type Property, type PropertySet } from '@ifc-lite/data';
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
  if (observed.number && !observed.text && !observed.boolean) return 'number';
  if (observed.boolean && !observed.text && !observed.number) return 'boolean';
  return 'category';
}

function observe(observed: ObservedKind, property: Property): void {
  const normalized = normalizeElementFieldValue(property.value, typeof property.value === 'number' ? 'number' : typeof property.value === 'boolean' ? 'boolean' : 'category');
  if (normalized.status !== 'value') return;
  if (typeof normalized.value === 'number') observed.number = true;
  else if (typeof normalized.value === 'boolean') observed.boolean = true;
  else observed.text = true;
  if (property.unit) observed.units.add(property.unit);
  if (property.dataType) observed.dataTypes.add(property.dataType.toUpperCase());
}

function observeRaw(observed: ObservedKind, raw: unknown): void {
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
  discover(expressIds: readonly number[]): ElementFieldCatalog;
}

/** Cached model-local reader. Recreate it when the store or mutation revision changes. */
export function createElementFieldReader(store: IfcDataStore, mutationView?: MutablePropertyView): ElementFieldReader {
  const provider = createListDataProvider(store);
  const attributes = new Map<number, Map<string, unknown>>();
  const occurrenceSets = new Map<number, PropertySet[]>();

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

  const propertyFor = (id: number, psetName: string, propertyName: string): Property | undefined => {
    const mutation = mutationView?.getPropertyMutation(id, psetName, propertyName);
    if (mutation?.operation === 'DELETE') {
      return { name: propertyName, type: PropertyValueType.String, value: null };
    }
    const occurrence = findPropertyInSets(setsFor(id), psetName, propertyName);
    // A present null/empty occurrence is authoritative and suppresses type fallback.
    if (occurrence) return occurrence;
    return findPropertyInSets(provider.getTypePropertySets?.(id) ?? [], psetName, propertyName);
  };

  return {
    read(id, binding) {
      const raw = binding.kind === 'attribute'
        ? attrsFor(id).get(binding.attributeName)
        : propertyFor(id, binding.psetName, binding.propertyName)?.value;
      return normalizeElementFieldValue(raw, binding.valueKind).value;
    },

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
          observeRaw(kind, raw);
        }
        ingest(setsFor(id));
        ingest(provider.getTypePropertySets?.(id) ?? []);
      }
      const attributeOptions = [...attributeNames]
        .sort()
        .map((attributeName) => ({ binding: { kind: 'attribute', attributeName, valueKind: inferKind(attributeKinds.get(attributeName) ?? emptyObservation()) } as const, label: attributeName }));
      const properties = new Map<string, ElementFieldOption[]>();
      for (const { psetName, propertyName, kind } of observed.values()) {
        const valueKind = inferKind(kind);
        const unit = valueKind === 'number' && kind.units.size === 1 ? [...kind.units][0] : undefined;
        const dataType = valueKind === 'number' && kind.dataTypes.size === 1 ? [...kind.dataTypes][0] : undefined;
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
