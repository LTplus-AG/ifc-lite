/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which meshes belong to the model an edit is being made in (#4929).
 *
 * The store keeps geometry in two places: per model on `FederatedModel.geometryResult`,
 * and a top-level `geometryResult` that mirrors the **active** model for the render
 * path and for legacy single-model call sites. Mesh `expressId`s are globalIds
 * (`localId + model.idOffset`), so resolving an element's globalId against its own
 * model and then looking that globalId up in the top-level mirror reads a *different*
 * model's geometry: it finds nothing when the edited model is not the active one, and
 * — if two loaded models ever collide on a globalId — the wrong element when it does.
 *
 * Picking in 3D does not change the active model, and the mutation actions all operate
 * on the selected element's own `modelId`, so "edited model !== active model" is the
 * normal federated case, not an edge case.
 *
 * The top-level mirror is therefore only a fallback for the model it actually mirrors.
 * For any other model, no geometry is the honest answer, and callers already handle it
 * (bounds go unavailable and they fall back or bail).
 */

import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { FederatedModel } from './types.js';

/** The three store fields that together say where a model's meshes live. */
export interface OwningModelMeshSource {
  models: ReadonlyMap<string, FederatedModel>;
  activeModelId: string | null;
  geometryResult: GeometryResult | null;
}

/**
 * Meshes of `modelId` — its own `geometryResult`, or the top-level mirror when
 * `modelId` IS the active model (legacy and geometry-first stores populate only the
 * mirror). `null` when neither applies; never another model's meshes.
 */
export function meshesForOwningModel(
  state: OwningModelMeshSource,
  modelId: string,
): MeshData[] | null {
  const own = state.models.get(modelId)?.geometryResult?.meshes;
  if (own) return own;
  if (state.activeModelId !== modelId) return null;
  return state.geometryResult?.meshes ?? null;
}
