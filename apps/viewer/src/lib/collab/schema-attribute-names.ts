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

function referenceType(registry: SchemaRegistry, type: string, seen = new Set<string>()): boolean {
  if (registry.entities[type]) return true;
  if (seen.has(type)) return true;
  seen.add(type);
  const members = registry.selects[type];
  return Boolean(members?.length) && members.every(member => referenceType(registry, member, seen));
}

/** Slots whose EXPRESS declaration admits only entity references. */
export function referenceAttributeSlotsForStore(store: IfcDataStore, type: string): boolean[] {
  if (store.schemaVersion === 'IFC5') return [];
  const registry = getSchemaRegistryForVersion(store.schemaVersion as SchemaVersionWithRegistry);
  const upper = type.toUpperCase();
  const entity = Object.values(registry.entities).find(candidate => candidate.name.toUpperCase() === upper);
  return entity?.allAttributes?.map(attribute => referenceType(registry, attribute.type)) ?? [];
}
