/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ListDataProvider, ListDefinition, PropertyCondition } from './types.js';

// ============================================================================
// Source Set Resolution
// ============================================================================

export function resolveSourceSet(
  definition: ListDefinition,
  provider: ListDataProvider,
  modelId: string,
  matchesAllConditions: (id: number, conditions: PropertyCondition[], provider: ListDataProvider) => boolean,
  capturedExpressIds?: ReadonlySet<number>,
): number[] {
  const { entityTypes, legacyConditions = [], expressIdsByModel } = definition;

  let entityIds: number[];
  if (expressIdsByModel) {
    // Explicit snapshot scope (e.g. from a filter result) — target exactly
    // the ids captured FOR THIS model. Keyed by model so a federated list
    // never picks up a foreign model's element that happens to share a
    // local express ID. Still intersect with this model for safety.
    const snapshot = expressIdsByModel[modelId] ?? [];
    entityIds = snapshot.filter((id) => provider.getEntityTypeName(id) !== '');
  } else if (entityTypes.length === 0) {
    // No class constraint — target every element in the model. Requires
    // the provider to enumerate all ids; older providers without it
    // resolve to an empty set rather than throwing.
    entityIds = provider.getAllEntityIds?.() ?? [];
  } else {
    // Collect entity IDs by type - gather arrays first, then flatten once
    const chunks: number[][] = [];
    for (const type of entityTypes) {
      const ids = provider.getEntitiesByType(type);
      if (ids.length > 0) chunks.push(ids);
    }
    entityIds = chunks.length === 1 ? chunks[0] : chunks.flat();
  }

  if (definition.capturedScope) {
    const captured = capturedExpressIds ?? provider.resolveCapturedScope?.(definition.capturedScope, modelId);
    if (!captured) throw new Error('This provider cannot resolve the captured file and entity scope. Nothing was run.');
    entityIds = entityIds.filter(id => captured.has(id));
  }

  // Apply conditions as filters
  if (legacyConditions.length === 0) {
    return entityIds;
  }

  return entityIds.filter(id => matchesAllConditions(id, legacyConditions, provider));
}
