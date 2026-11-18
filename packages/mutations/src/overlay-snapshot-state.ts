/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { OverlaySnapshot } from './cooperative-overlay-access.js';
import type { ForgottenEntityOverlay } from './mutable-overlay-state.js';
import type { ForgottenEntityOverlayV1, OverlaySnapshotV1, PropertySnapshotRow, QuantitySnapshotRow } from './overlay-snapshot-types.js';
import { attributeKey, propertyKey, quantityKey } from './types.js';

function memberRows<T>(rows: Iterable<[string, T]>, targets: ReadonlyMap<string, readonly [string, string]>, idOf: (key: string) => number): Array<[number, string, string, T]> {
  return Array.from(rows, ([key, row]) => {
    const target = targets.get(key);
    if (!target) throw new Error('Overlay row has no logical target; cannot persist it safely.');
    return [idOf(key), target[0], target[1], row];
  });
}
const entityId = (key: string): number => Number(key.slice(0, key.indexOf(':')));
const attributeName = (key: string): string => key.slice(key.indexOf(':attr:') + 6);
const setName = (key: string): string => key.slice(key.indexOf(':') + 1);

function forgottenRows(id: number, rows: ForgottenEntityOverlay, state: OverlaySnapshot): ForgottenEntityOverlayV1 {
  return {
    properties: memberRows(rows.propertyEntries, state.propertyTargets, () => id),
    quantities: memberRows(rows.quantityEntries, state.quantityTargets, () => id),
    attributes: rows.attributeEntries.map(([key, row]) => [id, attributeName(key), row]),
    positional: [...(rows.positionalAttrs ?? [])], retype: rows.typeMutation,
    createdSets: { property: [...(rows.newPsets?.values() ?? [])], quantity: [...(rows.newQsets?.values() ?? [])] },
    deletedSets: { property: rows.deletedPsetKeys.map(setName), quantity: rows.deletedQsetKeys.map(setName) },
    journal: rows.historyEntries,
  };
}

export function snapshotRows(state: OverlaySnapshot): OverlaySnapshotV1['state'] {
  return {
    properties: memberRows(state.propertyMutations, state.propertyTargets, entityId),
    quantities: memberRows(state.quantityMutations, state.quantityTargets, entityId),
    attributes: [...state.attributeMutations].map(([key, row]) => [entityId(key), attributeName(key), row]),
    positional: [...state.positionalAttrMutations].flatMap(([id, rows]) => [...rows].map(([index, value]): [number, number, typeof value] => [id, index, value])),
    retypes: [...state.typeMutations],
    createdSets: {
      property: [...state.newPsets].flatMap(([id, rows]) => [...rows.values()].map((row): [number, typeof row] => [id, row])),
      quantity: [...state.newQsets].flatMap(([id, rows]) => [...rows.values()].map((row): [number, typeof row] => [id, row])),
    },
    deletedSets: {
      property: [...state.deletedPsets].map(key => [entityId(key), setName(key)]),
      quantity: [...state.deletedQsets].map(key => [entityId(key), setName(key)]),
    },
    createdEntities: [...state.newEntities.values()], tombstones: [...state.tombstones], aliases: [...state.entityAliases],
    forgotten: [...state.forgottenCreatedEntities].map(id => ({ expressId: id, rows: state.forgottenEntityOverlay.has(id) ? forgottenRows(id, state.forgottenEntityOverlay.get(id)!, state) : null })),
  };
}

function unique<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) throw new Error('Duplicate overlay snapshot target.');
  map.set(key, value);
}
function bucket<K, V>(map: Map<number, Map<K, V>>, id: number, key: K, value: V): void {
  const rows = map.get(id) ?? new Map<K, V>(); unique(rows, key, value); map.set(id, rows);
}
function index(map: Map<number, Set<string>>, id: number, key: string): void {
  const keys = map.get(id) ?? new Set<string>(); keys.add(key); map.set(id, keys);
}
function propertyRows(rows: PropertySnapshotRow[], state: OverlaySnapshot): Array<[string, PropertySnapshotRow[3]]> {
  return rows.map(([id, set, name, row]) => {
    const key = propertyKey(id, set, name); state.propertyTargets.set(key, [set, name]); return [key, row];
  });
}
function quantityRows(rows: QuantitySnapshotRow[], state: OverlaySnapshot): Array<[string, QuantitySnapshotRow[3]]> {
  return rows.map(([id, set, name, row]) => {
    const key = quantityKey(id, set, name); state.quantityTargets.set(key, [set, name]); return [key, row];
  });
}

/** Rebuild primary maps and entity-key indices on an empty detached state. */
export function restoreRows(dto: OverlaySnapshotV1, state: OverlaySnapshot): OverlaySnapshot {
  for (const [key, row] of propertyRows(dto.state.properties, state)) { unique(state.propertyMutations, key, row); index(state.propertyKeysByEntity, entityId(key), key); }
  for (const [key, row] of quantityRows(dto.state.quantities, state)) { unique(state.quantityMutations, key, row); index(state.quantityKeysByEntity, entityId(key), key); }
  for (const [id, name, row] of dto.state.attributes) { const key = attributeKey(id, name); unique(state.attributeMutations, key, row); index(state.attributeKeysByEntity, id, key); }
  for (const [id, arg, value] of dto.state.positional) bucket(state.positionalAttrMutations, id, arg, value);
  for (const [id, row] of dto.state.retypes) unique(state.typeMutations, id, row);
  for (const [id, row] of dto.state.createdSets.property) bucket(state.newPsets, id, row.name, row);
  for (const [id, row] of dto.state.createdSets.quantity) bucket(state.newQsets, id, row.name, row);
  for (const [id, name] of dto.state.deletedSets.property) { const key = id + ':' + name; if (state.deletedPsets.has(key)) throw new Error('Duplicate set mask.'); state.deletedPsets.add(key); }
  for (const [id, name] of dto.state.deletedSets.quantity) { const key = id + ':' + name; if (state.deletedQsets.has(key)) throw new Error('Duplicate set mask.'); state.deletedQsets.add(key); }
  for (const row of dto.state.createdEntities) {
    unique(state.newEntities, row.expressId, row);
    state.nextAllocatedId = Math.max(state.nextAllocatedId, row.expressId);
  }
  for (const id of dto.state.tombstones) { if (state.tombstones.has(id) || state.newEntities.has(id)) throw new Error('Conflicting entity tombstone.'); state.tombstones.add(id); }
  for (const [id, source] of dto.state.aliases) unique(state.entityAliases, id, source);
  for (const { expressId: id, rows } of dto.state.forgotten) {
    if (state.newEntities.has(id) || state.forgottenCreatedEntities.has(id)) throw new Error('Conflicting forgotten entity.');
    state.forgottenCreatedEntities.add(id);
    if (rows) state.forgottenEntityOverlay.set(id, {
      propertyEntries: propertyRows(rows.properties, state), quantityEntries: quantityRows(rows.quantities, state),
      attributeEntries: rows.attributes.map(([entity, name, row]) => [attributeKey(entity, name), row]),
      positionalAttrs: rows.positional.length ? new Map(rows.positional) : null, typeMutation: rows.retype,
      newPsets: rows.createdSets.property.length ? new Map(rows.createdSets.property.map(row => [row.name, row])) : null,
      newQsets: rows.createdSets.quantity.length ? new Map(rows.createdSets.quantity.map(row => [row.name, row])) : null,
      deletedPsetKeys: rows.deletedSets.property.map(name => id + ':' + name), deletedQsetKeys: rows.deletedSets.quantity.map(name => id + ':' + name),
      historyEntries: rows.journal,
    });
    state.nextAllocatedId = Math.max(state.nextAllocatedId, id);
  }
  state.mutationHistory = dto.journal;
  state.nextAllocatedId = Math.max(state.nextAllocatedId, dto.nextExpressId - 1);
  return state;
}
