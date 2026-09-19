/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  getAttributeNamesAcrossSchemas,
  getSchemaRegistryForVersion,
  type IfcDataStore,
  type SchemaRegistry,
  type SchemaVersionWithRegistry,
} from '@ifc-lite/parser';

/** Resolve positional attributes against the model's actual IFC schema. */
export function attributeNamesForStore(store: IfcDataStore, type: string): string[] {
  if (store.schemaVersion === 'IFC5') return getAttributeNamesAcrossSchemas(type);
  const registry = getSchemaRegistryForVersion(store.schemaVersion as SchemaVersionWithRegistry);
  const upper = type.toUpperCase();
  const entity = Object.values(registry.entities).find(candidate => candidate.name.toUpperCase() === upper);
  return entity?.allAttributes?.map(attribute => attribute.name) ?? getAttributeNamesAcrossSchemas(type);
}

const REGISTRY_VERSIONS: readonly SchemaVersionWithRegistry[] = ['IFC4X3', 'IFC4', 'IFC2X3'];

function referenceType(registry: SchemaRegistry, type: string, seen = new Set<string>()): boolean {
  if (registry.entities[type]) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  const members = registry.selects[type];
  return Boolean(members?.length) && members.some(member => referenceType(registry, member, new Set(seen)));
}

function referenceSlots(registry: SchemaRegistry, type: string, names: readonly string[]): boolean[] {
  const upper = type.toUpperCase();
  const entity = Object.values(registry.entities).find(candidate => candidate.name.toUpperCase() === upper);
  if (!entity) return names.map(() => false);
  const byName = new Map(entity.allAttributes?.map(attribute => [attribute.name, attribute.type]) ?? []);
  return names.map(name => {
    const declaredType = byName.get(name);
    return declaredType ? referenceType(registry, declaredType) : false;
  });
}

/** Slots whose EXPRESS declaration admits an entity-reference branch. */
export function referenceAttributeSlotsForStore(store: IfcDataStore, type: string): boolean[] {
  const names = attributeNamesForStore(store, type);
  if (store.schemaVersion === 'IFC5') {
    const perRegistry = REGISTRY_VERSIONS.map(version => referenceSlots(
      getSchemaRegistryForVersion(version), type, names,
    ));
    return names.map((_, index) => perRegistry.some(slots => slots[index]));
  }
  const registry = getSchemaRegistryForVersion(store.schemaVersion as SchemaVersionWithRegistry);
  return referenceSlots(registry, type, names);
}
