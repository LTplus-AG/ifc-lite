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

/**
 * The id `normalizeMutationModelId` stamps onto the refs the SDK store adapter
 * mints while the legacy single-model path is active, and the key its mutation
 * views are registered under.
 *
 * It lives here rather than beside that normalizer because `getModelForRef`
 * has to accept it and `mutation-view.ts` already imports this module (#5234);
 * `mutation-view.ts` re-exports it so existing importers are unaffected.
 */
export const LEGACY_MUTATION_MODEL_ID = '__legacy__';

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
}

/**
 * Resolve a model by ID — checks the multi-model Map first,
 * then falls back to the legacy single-model state.
 */
export function getModelForRef(state: Pick<ViewerState, 'models' | 'ifcDataStore'>, modelId: string): ModelLike | undefined {
  const model = state.models.get(modelId);
  if (model) return model;

  // Legacy single-model fallback. `__legacy__` belongs in this list because
  // the store adapter hands it back on every ref it mints in single-model mode
  // (#5234): without it, feeding such a ref's `modelId` to any reader built on
  // this resolver — `bim.cost`, the mutation-view attribute reader — failed
  // with "Unknown modelId '__legacy__'" for an id this adapter itself issued.
  const legacyAlias = modelId === LEGACY_MODEL_ID
    || modelId === 'legacy'
    || modelId === LEGACY_MUTATION_MODEL_ID;
  if (legacyAlias && state.models.size === 0 && state.ifcDataStore) {
    return buildLegacyModel(state.ifcDataStore);
  }

  return undefined;
}

/**
 * List all model entries — from the multi-model Map or the legacy state.
 * Returns [modelId, model][] pairs.
 */
export function getAllModelEntries(state: Pick<ViewerState, 'models' | 'ifcDataStore'>): [string, ModelLike][] {
  if (state.models.size > 0) {
    return [...state.models.entries()];
  }

  // Legacy single-model fallback
  if (state.ifcDataStore) {
    return [[LEGACY_MODEL_ID, buildLegacyModel(state.ifcDataStore)]];
  }

  return [];
}

/**
 * The model an SDK call means when it names none — `bim.export.ifc()` with no
 * ref list (#4738). The user's active selection wins when that id still
 * resolves to an entry, then the first entry of the unified list, which is the
 * legacy single-model store when the federated Map is empty. `undefined` when
 * nothing is loaded.
 *
 * "Resolves to an entry" is not "has parsed data": a metadata-only entry (Tauri
 * native load, `ifcDataStore: null`) is returned like any other, and the caller
 * reports it cannot export that model rather than silently exporting a
 * different one.
 *
 * Three neighbours answer the same question with their own precedence and are
 * deliberately NOT changed here: `model-adapter.ts`'s `activeId` (does not
 * check the id resolves), and `schedule-adapter.ts` / `structural-adapter.ts`'s
 * `resolveStore` (legacy store before the active selection). Aligning them
 * would move which model those namespaces read in a federated session, which
 * is a behaviour change of its own.
 */
export function getDefaultModelId(state: ViewerState): string | undefined {
  const active = state.activeModelId;
  if (active && getModelForRef(state, active)) return active;
  return getAllModelEntries(state)[0]?.[0];
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
  };
}
