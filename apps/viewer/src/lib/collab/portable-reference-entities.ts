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
import type { ModelSlotRef } from '@ifc-lite/collab';
import { roomSlotPath } from './model-slot-ref';

const REFERENCE_LIST_ATTRIBUTES = new Set([
  'Components', 'CostQuantities', 'CostValues', 'Elements', 'HasQuantities',
  'RelatedDefinitions', 'RelatedObjects',
]);
const REFERENCE_SCALAR_ATTRIBUTES = new Set([
  'AppliedValue', 'ComponentOfTotal', 'DataValue', 'Dimensions', 'RelatingAppliedValue',
  'RelatingConstraint', 'Unit', 'UnitBasis', 'UnitComponent', 'RelatingActor', 'RelatingControl',
  'RelatingContext', 'RelatingGroup', 'RelatingObject', 'RelatingProcess', 'RelatingProduct', 'RelatingResource',
]);
// Only these root-level slots introduce a GUID-less portable subgraph. Once
// inside that graph we inspect every reference-shaped value, so the closure is
// complete without parsing every relationship in a large model up front.
const PORTABLE_ROOT_TYPES = new Set([
  'IFCCOSTITEM', 'IFCAPPLIEDVALUERELATIONSHIP', 'IFCRELASSIGNSTOCONTROL',
  'IFCRELASSIGNSTOPROCESS', 'IFCRELASSIGNSTOPRODUCT', 'IFCRELASSOCIATESAPPLIEDVALUE',
  'IFCRELASSOCIATESCONSTRAINT', 'IFCRELDECLARES', 'IFCRELNESTS', 'IFCRELSCHEDULESCOSTITEMS',
]);
const referenceIdsCache = new WeakMap<IfcDataStore, ReadonlySet<number>>();
const registryEntitiesCache = new WeakMap<SchemaRegistry, ReadonlyMap<string, SchemaRegistry['entities'][string]>>();

export function plainAttributeName(name: string): string {
  return name.split('::').at(-1) ?? name;
}

export function isPortableReferenceList(name: string): boolean {
  return REFERENCE_LIST_ATTRIBUTES.has(plainAttributeName(name));
}

export function isPortableReferenceScalar(name: string): boolean {
  return REFERENCE_SCALAR_ATTRIBUTES.has(plainAttributeName(name));
}

export function isPortableReferenceRootType(type: string): boolean {
  return PORTABLE_ROOT_TYPES.has(type.toUpperCase());
}

export function localReferenceId(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^#([1-9]\d*)$/.exec(value);
  return match ? Number(match[1]) : null;
}

/** Parsed IFC reference slots use numeric ids; callers must establish the slot is a reference first. */
export function explicitReferenceId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  return localReferenceId(value);
}

function schemaVersion(store: IfcDataStore): SchemaVersionWithRegistry {
  if (store.schemaVersion === 'IFC2X3') return 'IFC2X3';
  if (store.schemaVersion.startsWith('IFC4X3')) return 'IFC4X3';
  return 'IFC4';
}

function registryEntity(registry: SchemaRegistry, type: string) {
  let entities = registryEntitiesCache.get(registry);
  if (!entities) {
    entities = new Map(Object.values(registry.entities).map(entity => [entity.name.toUpperCase(), entity]));
    registryEntitiesCache.set(registry, entities);
  }
  return entities.get(type.toUpperCase());
}

function onlyEntityChoices(registry: SchemaRegistry, type: string, seen = new Set<string>()): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (registryEntity(registry, type)) return true;
  const choices = registry.selects[type];
  if (choices) return choices.length > 0
    && choices.every(choice => onlyEntityChoices(registry, choice, new Set(seen)));
  const underlying = registry.types[type];
  return underlying ? onlyEntityChoices(registry, underlying, seen) : false;
}

/** Numeric parser values are references only when the EXPRESS slot cannot also hold a measure. */
export function isUnambiguousReferenceAttribute(
  store: IfcDataStore,
  entityType: string,
  index: number,
): boolean {
  const registry = getSchemaRegistryForVersion(schemaVersion(store));
  const attribute = registryEntity(registry, entityType)?.allAttributes?.[index];
  return attribute ? onlyEntityChoices(registry, attribute.type) : false;
}

/** Resolve parsed STEP references without mistaking ordinary numeric measures for entity ids. */
export function portableReferenceId(
  store: IfcDataStore,
  entityType: string,
  index: number,
  attributeName: string,
  value: unknown,
): number | null {
  return isUnambiguousReferenceAttribute(store, entityType, index)
    || plainAttributeName(attributeName) === 'AppliedValue'
    ? explicitReferenceId(value)
    : localReferenceId(value);
}

function referencedIds(store: IfcDataStore, entityId: number, inspectAll: boolean): number[] {
  const entity = store.getEntity(entityId);
  if (!entity) return [];
  const names = getAttributeNamesAcrossSchemas(entity.type);
  const ids: number[] = [];
  entity.attributes.forEach((value, index) => {
    const name = names[index];
    if (!name) return;
    const referenceId = (candidate: unknown) =>
      portableReferenceId(store, entity.type, index, name, candidate);
    if ((inspectAll || isPortableReferenceList(name)) && Array.isArray(value)) {
      for (const member of value) {
        const id = referenceId(member);
        if (id !== null) ids.push(id);
      }
    } else if (inspectAll || isPortableReferenceScalar(name)) {
      const id = referenceId(value);
      if (id !== null) ids.push(id);
    }
  });
  return ids;
}

/** Non-IfcRoot rows that must have a room identity for cost/constraint references. */
export function portableReferenceEntityIds(store: IfcDataStore): ReadonlySet<number> {
  const cached = referenceIdsCache.get(store);
  if (cached) return cached;
  const result = new Set<number>();
  const queue: number[] = [];
  for (const [type, ids] of store.entityIndex?.byType ?? []) {
    if (!isPortableReferenceRootType(type)) continue;
    if (!registryEntity(getSchemaRegistryForVersion(schemaVersion(store)), type)?.allAttributes?.some(
      attribute => isPortableReferenceList(attribute.name) || isPortableReferenceScalar(attribute.name),
    )) continue;
    queue.push(...ids);
    for (const id of ids) {
      if (!store.entities.getGlobalId(id)) result.add(id);
    }
  }
  const scanned = new Set<number>();
  while (queue.length > 0) {
    const owner = queue.pop()!;
    if (scanned.has(owner)) continue;
    scanned.add(owner);
    const inspectAll = result.has(owner);
    for (const target of referencedIds(store, owner, inspectAll)) {
      if (!store.entities.getGlobalId(target)) result.add(target);
      if (!scanned.has(target)) queue.push(target);
    }
  }
  referenceIdsCache.set(store, result);
  return result;
}

export function portableEntityKey(store: IfcDataStore, entityId: number): string | null {
  const guid = store.entities?.getGlobalId?.(entityId);
  if (guid) return guid;
  if (!store.getEntity || !store.entityIndex?.byType) return null;
  if (!portableReferenceEntityIds(store).has(entityId)) return null;
  const base = `ifc-lite-ref-${entityId}`;
  let key = base;
  let suffix = 0;
  while (store.entities.getExpressIdByGlobalId(key) >= 0) {
    suffix += 1;
    key = `${base}-${suffix}`;
  }
  return key;
}

export function portableEntityPath(store: IfcDataStore, entityId: number, slot: ModelSlotRef): string | null {
  const key = portableEntityKey(store, entityId);
  return key ? roomSlotPath(slot, key) : null;
}
