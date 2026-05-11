/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MutablePropertyView } from '@ifc-lite/mutations';
import { extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import type { EntityAttributeData, EntityData } from '@ifc-lite/sdk';
import type { ViewerState } from '../../store/index.js';
import { getModelForRef, LEGACY_MODEL_ID } from './model-compat.js';
import type { StoreApi } from './types.js';

export const LEGACY_MUTATION_MODEL_ID = '__legacy__';

function isLegacyMutationRef(state: ViewerState, modelId: string): boolean {
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
  if (mutations.length === 0) return data;

  const next = { ...data };
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
  return next;
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
