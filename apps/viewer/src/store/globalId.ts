/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef, FederatedModel } from './types.js';

/** Shape accepted by `toGlobalIdFromModels` — re-export it so consumers can
 *  drop the `as unknown as Map<...>` cast when threading the store's
 *  federated `models` map through downstream helpers. */
export type ForwardModelMapLike = ReadonlyMap<string, { idOffset?: number }>;
export type ReverseModelMapLike = ReadonlyMap<string, Pick<FederatedModel, 'idOffset' | 'maxExpressId'>>;

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

/** The model shape both `localIdInParseRange` and `localIdInOverlay` need. */
export type OwnershipModel = Pick<FederatedModel, 'idOffset' | 'maxExpressId'>;

/** The mutation-view shape `localIdInOverlay` needs — just enough to ask "does an overlay entity live at this local id". */
export interface OwnershipView {
  getNewEntity(id: number): unknown;
}

/**
 * Parse-time ownership: a model owns `[idOffset, idOffset + maxExpressId]` from
 * the original parse. Returns the LOCAL express id, or `null`.
 *
 * `model.idOffset` bare, no `?? 0`: it is a required `number` on
 * `FederatedModel` (`store/types.ts`), and every caller of this has always
 * read it bare. `null` is returned for a miss, so a caller must test
 * `!== null` — local id `0` is a legitimate answer and a truthiness test
 * would drop it.
 *
 * The single shared home for this rule (#3343): `modelSlice.ts`'s unscoped
 * and scoped resolvers, and `teardown-scope.ts`'s `modelRemovedScope` survivor
 * check, all call this instead of re-spelling the range arithmetic. Before
 * the consolidation the three copies had already drifted once (#2697) and
 * were independently re-merged by an unrelated teardown refactor (#3358) —
 * nothing structurally stopped them drifting again.
 */
export function localIdInParseRange(model: OwnershipModel, globalId: number): number | null {
  const localId = globalId - model.idOffset;
  return localId >= 0 && localId <= model.maxExpressId ? localId : null;
}

/**
 * Overlay ownership: duplicates / scripted adds through StoreEditor land ABOVE
 * the model's parse-time `maxExpressId`, so `localIdInParseRange` cannot see
 * them; the model's mutation view can. Returns the LOCAL express id, or `null`.
 */
export function localIdInOverlay(
  model: OwnershipModel,
  globalId: number,
  view: OwnershipView | undefined,
): number | null {
  if (!view) return null;
  const localId = globalId - model.idOffset;
  if (localId <= model.maxExpressId) return null; // parse-range's business
  return view.getNewEntity(localId) !== null ? localId : null;
}
