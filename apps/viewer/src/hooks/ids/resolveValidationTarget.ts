/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';

/** Minimal shape the resolver needs from a federated model. */
export interface ValidationTargetModel {
  ifcDataStore: IfcDataStore | null;
}

export interface ResolveValidationTargetInput {
  /**
   * Model explicitly requested by the caller (the federation picker). When
   * present it is authoritative: the resolver never falls back to another
   * model, because doing so would validate one model's data while labeling
   * the report with a different model's id.
   */
  targetModelId?: string;
  /** The active model id, or null. Used only when no explicit target is given. */
  activeModelId: string | null;
  /** All loaded federated models keyed by id. */
  models: Map<string, ValidationTargetModel>;
  /** The legacy single-model data store, or null. */
  legacyDataStore: IfcDataStore | null;
}

export type ResolveValidationTargetResult =
  | { modelId: string; dataStore: IfcDataStore }
  | { error: string };

/**
 * Resolve which model to validate and the data store to validate against.
 *
 * Two modes:
 * - Explicit target (federation picker): honor it exactly. If the named model
 *   is unknown or has no parsed data store, return an error rather than falling
 *   back — a silent fallback would validate the active model's data while the
 *   report claims to describe the picked (empty / mid-load) model.
 * - No target (active-model / legacy path): keep the existing fallback chain —
 *   active model, else first loaded, else legacy single-model — resolving the
 *   data store from that model, else the legacy store, else the first model.
 */
export function resolveValidationTarget(
  input: ResolveValidationTargetInput,
): ResolveValidationTargetResult {
  const { targetModelId, activeModelId, models, legacyDataStore } = input;

  if (targetModelId != null) {
    const model = models.get(targetModelId);
    if (!model) {
      return { error: `Model "${targetModelId}" is not loaded` };
    }
    if (!model.ifcDataStore) {
      return { error: 'The selected model has no parsed IFC data to validate' };
    }
    return { modelId: targetModelId, dataStore: model.ifcDataStore };
  }

  // No explicit target: active model, else first loaded, else legacy.
  const modelId =
    activeModelId
    || (models.size > 0 ? Array.from(models.keys())[0] : '__legacy__');

  const dataStore =
    models.get(modelId)?.ifcDataStore
    || legacyDataStore
    || (models.size > 0 ? Array.from(models.values())[0]?.ifcDataStore ?? null : null);

  if (!dataStore) {
    return { error: 'No IFC model loaded' };
  }
  return { modelId, dataStore };
}
