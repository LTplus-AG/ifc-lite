/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Legacy single-model compatibility layer.
 *
 * The viewer has two loading paths:
 * - Single file: `loadFile()` stores data in `state.ifcDataStore` / `state.geometryResult`
 * - Multi-model: `addModel()` stores each model in `state.models` Map
 *
 * SDK adapters need to query entities regardless of which path was used.
 * These helpers provide a unified view by falling back to the legacy
 * single-model state when the `models` Map is empty.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { SchemaVersion } from '@ifc-lite/sdk';
import type { ViewerState } from '../../store/index.js';

/** Sentinel model ID used for the legacy single-model path */
export const LEGACY_MODEL_ID = 'default';

/** Minimal model shape needed by the SDK adapters.
 *
 * `ifcDataStore` is nullable because the federated model store also
 * carries native-metadata-only entries (loaded through Tauri without a
 * full STEP parse). Adapters that need the data store check for null
 * before using it.
 */
export interface ModelLike {
  id: string;
  name: string;
  ifcDataStore: IfcDataStore | null;
  schemaVersion: SchemaVersion;
  fileSize: number;
  loadedAt: number;
  idOffset: number;
  maxExpressId: number;
}

/**
 * Resolve a model by ID — checks the multi-model Map first,
 * then falls back to the legacy single-model state.
 */
export function getModelForRef(state: ViewerState, modelId: string): ModelLike | undefined {
  const model = state.models.get(modelId);
  if (model) return model;

  // Legacy single-model fallback
  if ((modelId === LEGACY_MODEL_ID || modelId === 'legacy') && state.models.size === 0 && state.ifcDataStore) {
    return buildLegacyModel(state.ifcDataStore);
  }

  return undefined;
}

/**
 * List all model entries — from the multi-model Map or the legacy state.
 * Returns [modelId, model][] pairs.
 */
export function getAllModelEntries(state: ViewerState): [string, ModelLike][] {
  if (state.models.size > 0) {
    return [...state.models.entries()];
  }

  // Legacy single-model fallback
  if (state.ifcDataStore) {
    return [[LEGACY_MODEL_ID, buildLegacyModel(state.ifcDataStore)]];
  }

  return [];
}

function buildLegacyModel(dataStore: IfcDataStore): ModelLike {
  return {
    id: LEGACY_MODEL_ID,
    name: 'Model',
    ifcDataStore: dataStore,
    schemaVersion: dataStore.schemaVersion ?? 'IFC4',
    fileSize: dataStore.source?.byteLength ?? 0,
    loadedAt: 0,
    idOffset: 0,
    maxExpressId: dataStore.entities?.count ?? 0,
  };
}
