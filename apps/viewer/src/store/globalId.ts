/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef, FederatedModel } from './types.js';

/** Shape accepted by `toGlobalIdFromModels` — re-export it so consumers can
 *  drop the `as unknown as Map<...>` cast when threading the store's
 *  federated `models` map through downstream helpers. */
export type ForwardModelMapLike = ReadonlyMap<string, { idOffset?: number }>;
type ReverseModelMapLike = ReadonlyMap<string, Pick<FederatedModel, 'idOffset' | 'maxExpressId'>>;

/**
 * Convert a local expressId to the renderer/global ID space.
 *
 * This is the viewer-level single source of truth for modelId + expressId →
 * globalId conversion outside Zustand hooks. It preserves single-model legacy
 * behavior by falling back to the original expressId when no federated model
 * entry exists.
 */
export function toGlobalIdFromModels(
  models: ForwardModelMapLike,
  modelId: string,
  expressId: number,
): number {
  if (modelId === 'legacy' || modelId === 'default' || modelId === '__legacy__') {
    return expressId;
  }

  const model = models.get(modelId);
  if (!model) {
    return expressId;
  }

  return expressId + (model.idOffset ?? 0);
}

/**
 * Resolve a renderer/global ID back to the source model and local expressId.
 *
 * This mirrors toGlobalIdFromModels and preserves legacy single-model behavior.
 */
export function fromGlobalIdFromModels(
  models: ReverseModelMapLike,
  globalId: number,
): EntityRef | undefined {
  // No models loaded — legacy single-store fallback (expressId === globalId).
  if (models.size === 0) {
    return { modelId: 'legacy', expressId: globalId };
  }

  // Resolve through every model by its offset range, regardless of count.
  // For a true single model with idOffset 0 this still yields expressId === globalId.
  // The `>= 0` boundary matches the canonical resolveGlobalIdFromModels (modelSlice.ts).
  for (const [modelId, model] of models.entries()) {
    const localExpressId = globalId - model.idOffset;
    if (localExpressId >= 0 && localExpressId <= model.maxExpressId) {
      return {
        modelId,
        expressId: localExpressId,
      };
    }
  }

  // Single-model graceful fallback: if exactly one model and the offset
  // range check missed (e.g. overlay-allocated id above maxExpressId),
  // still return that model with the offset-corrected id rather than undefined.
  if (models.size === 1) {
    const [modelId, model] = models.entries().next().value!;
    return { modelId, expressId: globalId - model.idOffset };
  }

  return undefined;
}

/**
 * Convert an EntityRef to the renderer/global ID space.
 */
export function toGlobalIdForRef(
  models: ForwardModelMapLike,
  ref: EntityRef,
): number {
  return toGlobalIdFromModels(models, ref.modelId, ref.expressId);
}
