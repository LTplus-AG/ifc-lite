/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getAttributeNamesAcrossSchemas, type IfcDataStore } from '@ifc-lite/parser';
import type { ModelSlotRef } from '@ifc-lite/collab';
import { roomSlotPath } from './model-slot-ref';

const REFERENCE_LIST_ATTRIBUTES = new Set([
  'Components', 'CostQuantities', 'CostValues', 'RelatedDefinitions', 'RelatedObjects',
]);
const REFERENCE_SCALAR_ATTRIBUTES = new Set([
  'AppliedValue', 'DataValue', 'Dimensions', 'Unit', 'UnitBasis', 'UnitComponent', 'RelatingActor', 'RelatingControl',
  'RelatingGroup', 'RelatingObject', 'RelatingProcess', 'RelatingProduct', 'RelatingResource',
]);
const referenceIdsCache = new WeakMap<IfcDataStore, ReadonlySet<number>>();

export function plainAttributeName(name: string): string {
  return name.split('::').at(-1) ?? name;
}

export function isPortableReferenceList(name: string): boolean {
  return REFERENCE_LIST_ATTRIBUTES.has(plainAttributeName(name));
}

export function isPortableReferenceScalar(name: string): boolean {
  return REFERENCE_SCALAR_ATTRIBUTES.has(plainAttributeName(name));
}

export function localReferenceId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const match = /^#([1-9]\d*)$/.exec(value);
  return match ? Number(match[1]) : null;
}

function referencedIds(store: IfcDataStore, entityId: number): number[] {
  const entity = store.getEntity(entityId);
  if (!entity) return [];
  const names = getAttributeNamesAcrossSchemas(entity.type);
  const ids: number[] = [];
  entity.attributes.forEach((value, index) => {
    const name = names[index];
    if (!name) return;
    if (isPortableReferenceList(name) && Array.isArray(value)) {
      for (const member of value) {
        const id = localReferenceId(member);
        if (id !== null) ids.push(id);
      }
    } else if (isPortableReferenceScalar(name)) {
      const id = localReferenceId(value);
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
    const names = getAttributeNamesAcrossSchemas(type);
    if (!names.some(name => isPortableReferenceList(name) || isPortableReferenceScalar(name))) continue;
    queue.push(...ids);
  }
  const scanned = new Set<number>();
  while (queue.length > 0) {
    const owner = queue.pop()!;
    if (scanned.has(owner)) continue;
    scanned.add(owner);
    for (const target of referencedIds(store, owner)) {
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
  return portableReferenceEntityIds(store).has(entityId) ? `ifc-lite-ref-${entityId}` : null;
}

export function portableEntityPath(store: IfcDataStore, entityId: number, slot: ModelSlotRef): string | null {
  const key = portableEntityKey(store, entityId);
  return key ? roomSlotPath(slot, key) : null;
}
