/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MutablePropertyView } from '@ifc-lite/mutations';
import { extractPropertiesOnDemand, extractQuantitiesOnDemand, getAttributeNamesForSchema, normalizeIfcTypeName } from '@ifc-lite/parser';
import type { EntityAttributeData, EntityData, PropertySetData, QuantitySetData } from '@ifc-lite/sdk';
import type { ViewerState } from '../../store/index.js';
import { resolveBaseAttributeValue } from '../../utils/configureMutationView.js';
import { getModelForRef, LEGACY_MODEL_ID } from './model-compat.js';
import type { StoreApi } from './types.js';

export const LEGACY_MUTATION_MODEL_ID = '__legacy__';

export function isLegacyMutationRef(state: ViewerState, modelId: string): boolean {
  return state.models.size === 0 && (modelId === 'legacy' || modelId === LEGACY_MODEL_ID || modelId === LEGACY_MUTATION_MODEL_ID);
}

export function normalizeMutationModelId(state: ViewerState, modelId: string): string {
  if (isLegacyMutationRef(state, modelId)) {
    return LEGACY_MUTATION_MODEL_ID;
  }
  return modelId;
}

export function getMutationViewForModel(store: StoreApi, modelId: string): MutablePropertyView | null {
  const state = store.getState();
  return state.getMutationView?.(normalizeMutationModelId(state, modelId)) ?? null;
}

export function getOrCreateMutationView(store: StoreApi, modelId: string): MutablePropertyView | null {
  const state = store.getState();
  const normalizedModelId = normalizeMutationModelId(state, modelId);
  const existing = state.getMutationView?.(normalizedModelId);
  if (existing) return existing;

  const modelRefId = isLegacyMutationRef(state, modelId) ? LEGACY_MODEL_ID : modelId;
  const model = getModelForRef(state, modelRefId);
  const dataStore = model?.ifcDataStore;
  if (!dataStore) return null;

  const mutationView = new MutablePropertyView(dataStore.properties || null, normalizedModelId);

  if (dataStore.onDemandPropertyMap && dataStore.source?.length) {
    mutationView.setOnDemandExtractor((entityId: number) => (
      extractPropertiesOnDemand(dataStore, entityId)
    ));
  }

  if (dataStore.onDemandQuantityMap && dataStore.source?.length) {
    mutationView.setQuantityExtractor((entityId: number) => (
      extractQuantitiesOnDemand(dataStore, entityId)
    ));
  }

  mutationView.setAttributeExtractor((entityId: number, attrName: string) =>
    resolveBaseAttributeValue(dataStore, entityId, attrName));

  state.registerMutationView?.(normalizedModelId, mutationView);
  return mutationView;
}

export function applyAttributeMutationsToEntityData(
  store: StoreApi,
  modelId: string,
  expressId: number,
  data: EntityData,
): EntityData {
  const mutationView = getMutationViewForModel(store, modelId);
  if (!mutationView) return data;

  const mutations = mutationView.getAttributeMutationsForEntity(expressId);
  const positional = mutationView.getPositionalMutationsForEntity(expressId);
  const retype = mutationView.getEntityTypeMutation(expressId)?.newType;
  if (mutations.length === 0 && !positional?.size && !retype) return data;

  // A queued retype is the entity's class for every read, and names its slots.
  const next = { ...data, type: retype ? normalizeIfcTypeName(retype) : data.type };
  for (const mutation of mutations) {
    switch (mutation.name) {
      case 'GlobalId':
        next.globalId = mutation.value;
        break;
      case 'Name':
        next.name = mutation.value;
        break;
      case 'Description':
        next.description = mutation.value;
        break;
      case 'ObjectType':
        next.objectType = mutation.value;
        break;
    }
  }
  const state = store.getState();
  const dataStore = getModelForRef(state, modelId)?.ifcDataStore;
  if (dataStore && (positional || retype)) {
    // Positional slots are named by the EFFECTIVE class (a queued retype wins
    // over the stored type), exactly as export lays them out.
    const exactType = retype ?? (dataStore.entities.getTypeName(expressId) || data.type);
    const names = getAttributeNamesForSchema(exactType, dataStore.schemaVersion);
    // A retype re-lays the record out by name: a header slot the effective
    // class does not declare is gone from the saved file, so it is gone here.
    if (retype && names.length > 0 && !names.includes('ObjectType')) next.objectType = '';
    for (const [index, value] of positional ?? []) {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      const unset = value == null || trimmed === '' || trimmed === '$' || trimmed === '*';
      const text = unset ? '' : typeof value === 'string'
        ? trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")
          ? trimmed.slice(1, -1).replace(/''/g, "'")
          : trimmed
        : null;
      if (text === null) continue;
      if (names[index] === 'GlobalId') next.globalId = text;
      else if (names[index] === 'Name') next.name = text;
      else if (names[index] === 'Description') next.description = text;
      else if (names[index] === 'ObjectType') next.objectType = text;
    }
  }
  return next;
}

/**
 * `getProperties`'s overlay half — matches `packages/cli/src/query-overlay.ts`'s
 * `overlayProperties`. Once a mutation view exists at all, it is the whole
 * answer for every entity (mutated or not): `getForEntity` already merges the
 * on-demand base data with any SET/DELETE mutations, the same merge
 * `StepExporter` reads for `bim.export.ifc()`. `undefined` means only "no
 * mutation view yet" (a session that has made no edits) — the one case that
 * still falls through to the parsed store; a deleted entity answers `[]`.
 */
export function overlayProperties(store: StoreApi, modelId: string, expressId: number): PropertySetData[] | undefined {
  const view = getMutationViewForModel(store, modelId);
  if (!view) return undefined;
  if (view.isDeleted(expressId)) return [];
  return view.getForEntity(expressId).map((pset) => ({
    name: pset.name,
    globalId: pset.globalId,
    properties: pset.properties.map((p) => ({
      name: p.name,
      type: p.type,
      value: p.value as string | number | boolean | null,
    })),
  }));
}

/** `getQuantities`'s overlay half — see {@link overlayProperties}. */
export function overlayQuantities(store: StoreApi, modelId: string, expressId: number): QuantitySetData[] | undefined {
  const view = getMutationViewForModel(store, modelId);
  if (!view) return undefined;
  if (view.isDeleted(expressId)) return [];
  return view.getQuantitiesForEntity(expressId).map((qset) => ({
    name: qset.name,
    quantities: qset.quantities.map((q) => ({ name: q.name, type: q.type, value: q.value })),
  }));
}

export function mergeAttributeMutations(
  baseAttributes: EntityAttributeData[],
  store: StoreApi,
  modelId: string,
  expressId: number,
): EntityAttributeData[] {
  const mutationView = getMutationViewForModel(store, modelId);
  if (!mutationView) return baseAttributes;

  const mutations = mutationView.getAttributeMutationsForEntity(expressId);
  if (mutations.length === 0) return baseAttributes;

  const merged = new Map<string, string | number | boolean>();
  for (const attr of baseAttributes) {
    merged.set(attr.name, attr.value);
  }
  for (const mutation of mutations) {
    merged.set(mutation.name, mutation.value);
  }

  return [...merged.entries()].map(([name, value]) => ({ name, value }));
}
