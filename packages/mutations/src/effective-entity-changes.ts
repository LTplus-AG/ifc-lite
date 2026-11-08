/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { EffectiveChangesSnapshot } from './effective-changes.js';

/** Narrow before collecting, rather than collecting the session then filtering. */
export function changesForEntity(state: EffectiveChangesSnapshot, id: number, attributeKeys: Iterable<string>): EffectiveChangesSnapshot {
  const one = <T>(map: ReadonlyMap<number, T>) => map.has(id) ? new Map([[id, map.get(id)!]]) : new Map<number, T>();
  const rows = <T>(map: ReadonlyMap<string, T>, keys: Iterable<string>) => new Map([...keys].map(key => [key, map.get(key)!]));
  const member = (set: ReadonlySet<number>) => new Set(set.has(id) ? [id] : []);
  return {
    attributeMutations: rows(state.attributeMutations, attributeKeys),
    positionalAttrMutations: one(state.positionalAttrMutations), typeMutations: one(state.typeMutations),
    newPsets: one(state.newPsets), newQsets: one(state.newQsets),
    deletedPsets: new Set([...state.deletedPsets].filter(key => key.startsWith(`${id}:`))),
    deletedQsets: new Set([...state.deletedQsets].filter(key => key.startsWith(`${id}:`))),
    propertyKeysByEntity: one(state.propertyKeysByEntity), quantityKeysByEntity: one(state.quantityKeysByEntity),
    propertyMutations: rows(state.propertyMutations, state.propertyKeysByEntity.get(id) ?? []),
    quantityMutations: rows(state.quantityMutations, state.quantityKeysByEntity.get(id) ?? []),
    newEntities: one(state.newEntities), tombstones: member(state.tombstones), forgottenCreatedEntities: member(state.forgottenCreatedEntities),
  };
}
