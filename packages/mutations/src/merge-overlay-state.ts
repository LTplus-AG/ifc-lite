/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cooperativeOverlay, type OverlaySnapshot } from './cooperative-overlay-access.js';
import { withoutEntityExposure } from './entity-read-barrier.js';
import type { MutablePropertyView } from './mutable-property-view.js';
import { NewEntityMap } from './new-entity-map.js';
import { sameOverlayValue } from './overlay-value-equality.js';
import { materializeOverlay } from './sparse-overlay.js';
import { attributeKey, propertyKey, quantityKey, type Mutation } from './types.js';

function mapUnion<K, V>(lower: Map<K, V>, preferred: Map<K, V>): Map<K, V> {
  return new Map([...lower, ...preferred]);
}

function setUnion<T>(lower: Set<T>, preferred: Set<T>): Set<T> {
  return new Set([...lower, ...preferred]);
}

function unionBuckets<K, V>(
  lower: Map<number, Map<K, V>>,
  preferred: Map<number, Map<K, V>>,
): Map<number, Map<K, V>> {
  const result = new Map(lower);
  for (const [id, rows] of preferred) {
    result.set(id, mapUnion(result.get(id) ?? new Map<K, V>(), rows));
  }
  return result;
}

function unionIndexes(lower: Map<number, Set<string>>, preferred: Map<number, Set<string>>) {
  const result = new Map(lower);
  for (const [id, keys] of preferred) result.set(id, setUnion(result.get(id) ?? new Set(), keys));
  return result;
}

function setTarget(key: string): number {
  return Number(key.slice(0, key.indexOf(':')));
}

function structuralIds(state: OverlaySnapshot): number[] {
  return [
    ...state.newEntities.keys(),
    ...state.tombstones, ...state.forgottenCreatedEntities, ...state.forgottenEntityOverlay.keys(),
    ...state.entityAliases.keys(), ...state.entityAliases.values(),
    ...state.typeMutations.keys(), ...state.positionalAttrMutations.keys(),
  ];
}

function editedIds(state: OverlaySnapshot): Set<number> {
  return new Set([
    ...structuralIds(state), ...state.attributeKeysByEntity.keys(),
    ...state.propertyKeysByEntity.keys(), ...state.quantityKeysByEntity.keys(),
    ...state.newPsets.keys(), ...state.newQsets.keys(),
    ...Array.from(state.deletedPsets, setTarget), ...Array.from(state.deletedQsets, setTarget),
  ]);
}

function modifiedSets(state: OverlaySnapshot, kind: 'property' | 'quantity'): Set<string> {
  const property = kind === 'property';
  const rows = property ? state.propertyMutations : state.quantityMutations;
  const targets = property ? state.propertyTargets : state.quantityTargets;
  const result = new Set(property ? state.deletedPsets : state.deletedQsets);
  for (const [id, sets] of property ? state.newPsets : state.newQsets) {
    for (const name of sets.keys()) result.add(id + ':' + name);
  }
  for (const key of rows.keys()) {
    const target = targets.get(key);
    if (!target) throw new Error('An overlay edit has no set target.');
    result.add(setTarget(key) + ':' + target[0]);
  }
  return result;
}

function assertCompatible(from: OverlaySnapshot, other: OverlaySnapshot): void {
  const otherEntities = editedIds(other);
  for (const id of structuralIds(from)) {
    if (otherEntities.has(id)) throw new Error(`Conflicting overlay edits on entity #${id}.`);
  }
  for (const kind of ['property', 'quantity'] as const) {
    const property = kind === 'property';
    const otherSets = modifiedSets(other, kind);
    const changedSets = new Set(property ? from.deletedPsets : from.deletedQsets);
    for (const [id, sets] of property ? from.newPsets : from.newQsets) {
      for (const name of sets.keys()) changedSets.add(id + ':' + name);
    }
    for (const key of changedSets) {
      if (otherSets.has(key)) throw new Error(`Conflicting overlay edits on ${kind} set ${key}.`);
    }
  }
}

function captureSnapshot(access: ReturnType<typeof cooperativeOverlay>): OverlaySnapshot {
  return withoutEntityExposure(() => structuredClone(materializeOverlay(access.capture())));
}

function mergeSnapshots(preferred: OverlaySnapshot, other: OverlaySnapshot): OverlaySnapshot {
  assertCompatible(preferred, other);
  assertCompatible(other, preferred);

  const journal = new Map(other.mutationHistory.map(row => [row.id, row]));
  for (const row of preferred.mutationHistory) {
    const recorded = journal.get(row.id);
    if (recorded && !sameOverlayValue(recorded, row)) throw new Error('Conflicting overlay history entries.');
    journal.set(row.id, row);
  }
  return {
    propertyTargets: mapUnion(other.propertyTargets, preferred.propertyTargets),
    quantityTargets: mapUnion(other.quantityTargets, preferred.quantityTargets),
    propertyMutations: mapUnion(other.propertyMutations, preferred.propertyMutations),
    quantityMutations: mapUnion(other.quantityMutations, preferred.quantityMutations),
    propertyKeysByEntity: unionIndexes(other.propertyKeysByEntity, preferred.propertyKeysByEntity),
    quantityKeysByEntity: unionIndexes(other.quantityKeysByEntity, preferred.quantityKeysByEntity),
    attributeKeysByEntity: unionIndexes(other.attributeKeysByEntity, preferred.attributeKeysByEntity),
    deletedPsets: setUnion(other.deletedPsets, preferred.deletedPsets),
    deletedQsets: setUnion(other.deletedQsets, preferred.deletedQsets),
    newPsets: unionBuckets(other.newPsets, preferred.newPsets),
    newQsets: unionBuckets(other.newQsets, preferred.newQsets),
    attributeMutations: mapUnion(other.attributeMutations, preferred.attributeMutations),
    positionalAttrMutations: unionBuckets(other.positionalAttrMutations, preferred.positionalAttrMutations),
    typeMutations: mapUnion(other.typeMutations, preferred.typeMutations),
    newEntities: NewEntityMap.from(mapUnion(other.newEntities, preferred.newEntities)),
    // Rebuild reference candidates from the combined attribute and type rows.
    overriddenEntities: new NewEntityMap(),
    overriddenSourceIds: new Set(),
    tombstones: setUnion(other.tombstones, preferred.tombstones),
    forgottenCreatedEntities: setUnion(other.forgottenCreatedEntities, preferred.forgottenCreatedEntities),
    forgottenEntityOverlay: mapUnion(other.forgottenEntityOverlay, preferred.forgottenEntityOverlay),
    entityAliases: mapUnion(other.entityAliases, preferred.entityAliases),
    nextAllocatedId: Math.max(other.nextAllocatedId, preferred.nextAllocatedId),
    mutationHistory: [...journal.values()].sort((left, right) => left.timestamp - right.timestamp),
  };
}

function shadows(state: OverlaySnapshot, mutation: Mutation): boolean {
  if (mutation.type === 'UPDATE_ATTRIBUTE' && mutation.attributeName) {
    return state.attributeMutations.has(attributeKey(mutation.entityId, mutation.attributeName));
  }
  if (!mutation.psetName || !mutation.propName) return false;
  const target = [mutation.entityId, mutation.psetName, mutation.propName] as const;
  switch (mutation.type) {
    case 'CREATE_PROPERTY':
    case 'UPDATE_PROPERTY':
    case 'DELETE_PROPERTY':
      return state.propertyMutations.has(propertyKey(...target));
    case 'CREATE_QUANTITY':
    case 'UPDATE_QUANTITY':
    case 'DELETE_QUANTITY':
      return state.quantityMutations.has(quantityKey(...target));
    default:
      return false;
  }
}

/** Stage alias reconciliation for views of the same source. Owners can
 * validate their replay histories before publishing the combined overlay.
 */
export function prepareMutationViewMerge(preferred: MutablePropertyView, others: readonly MutablePropertyView[]) {
  const live = cooperativeOverlay(preferred);
  const original = captureSnapshot(live);
  const shadowedBy = new Map<string, OverlaySnapshot>();
  const sources = [...new Set(others)].filter(view => view !== preferred).map(view => {
    const access = cooperativeOverlay(view);
    return { access, original: captureSnapshot(access) };
  });
  let snapshot = original;
  for (const source of sources) {
    const modelId = source.access.modelId;
    if (modelId === live.modelId || shadowedBy.has(modelId)) throw new Error('Conflicting overlay history owners.');
    shadowedBy.set(modelId, snapshot);
    snapshot = mergeSnapshots(snapshot, source.original);
  }

  const merged = sources.length > 0 ? live.rebuild(snapshot) : original;
  let committed = false;
  return {
    isShadowed(mutation: Mutation): boolean {
      const owner = shadowedBy.get(mutation.modelId);
      return owner !== undefined && shadows(owner, mutation);
    },
    commit(): void {
      if (committed) return;
      if (!live.matches(original) || sources.some(source => !source.access.matches(source.original))) {
        throw new Error('The overlay changed during alias reconciliation.');
      }
      if (sources.length > 0) live.publish(merged);
      committed = true;
    },
  };
}
