/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { FederatedModel } from '@/store';

/** #4428: model visibility masks retained GPU instances independently of user hides.
 * The entity table also covers instance-only owners when geometry hashing is off.
 * Mesh IDs are already global and include overlay-created products.
 */
export function modelHiddenEntities(
  models: ReadonlyMap<string, FederatedModel>,
  userHidden: Set<number>,
  toGlobalId: (modelId: string, expressId: number) => number,
): Set<number> {
  let hidden = userHidden;
  for (const [modelId, model] of models) {
    if (model.visible) continue;
    if (hidden === userHidden) hidden = new Set(userHidden);
    for (const id of model.ifcDataStore?.entities.expressId ?? []) {
      if (model.ifcDataStore!.entities.hasGeometry(id)) hidden.add(toGlobalId(modelId, id));
    }
    const geometry = model.geometryResult;
    for (const mesh of geometry?.meshes ?? []) {
      for (const id of mesh.entityIds ?? [mesh.expressId]) hidden.add(id);
    }
    for (const id of geometry?.instancedGeometryAabbs?.keys() ?? []) hidden.add(id);
    for (const id of geometry?.instancedGeometryHashes?.keys() ?? []) hidden.add(id);
  }
  return hidden;
}

/** Match shard ownership's index-zero fallback, retaining hidden loaded models. */
export function loadedInstancedModelIndices(
  models: ReadonlyMap<string, FederatedModel>,
  modelIdToIndex: ReadonlyMap<string, number> | undefined,
): Set<number> | undefined {
  if (!modelIdToIndex?.size) return undefined;
  const present = new Set<number>([0]);
  for (const [modelId, index] of modelIdToIndex) {
    if (models.has(modelId)) present.add(index);
  }
  return present;
}
