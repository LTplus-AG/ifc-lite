/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A streamed scan's federation identity (#6887).
 *
 * Every streamed format (LAS, LAZ, E57, PLY, PCD, PTS, XYZ, and COPC, which
 * `ingestPointCloud` routes through `streamPointCloudOrCopc`) opens ONE
 * renderer asset before its model is registered, so the asset starts with a
 * local synthetic expressId and no model index. `useIfcLoader.loadFile` binds
 * it here once `finalizeModel` has registered the model, for every format and
 * for both primary and federated loads:
 *
 * - `expressId` becomes the global id on the model's point-cloud descriptor
 *   (finalize adds the model's `idOffset`), which `resolveGlobalIdFromModels`
 *   maps back to this model. That is how the Deviation CSV names the row.
 * - `modelIndex` becomes the model's index from `modelIndices`, the allocator
 *   that also stamps meshes and IFCX point clouds, so a pick or a deviation
 *   readback no longer reports the `?? 0` default for a scan that is not
 *   model 0.
 *
 * Neither value shifts when another model is removed: offsets are per model,
 * and `modelIndices` never compacts a live federation. The asset is freed
 * together with its own model (`usePointCloudLifecycle`).
 */

import type { Renderer } from '@ifc-lite/renderer';
import type { FederatedModel } from '../../store/types.js';
import { modelIndices } from '../../lib/model-placement/model-indices.js';

export function bindPointCloudIdentity(
  renderer: Pick<Renderer, 'relabelPointCloudAsset'>,
  handle: { id: number },
  modelId: string,
  models: ReadonlyMap<string, FederatedModel>,
): void {
  const model = models.get(modelId);
  // Only the model that owns this handle: a superseded load must not relabel
  // its asset with a newer model's identity.
  const asset = model?.pointCloudHandleId === handle.id ? model.geometryResult?.pointClouds?.[0] : undefined;
  if (!asset) return;
  renderer.relabelPointCloudAsset(handle, asset.expressId, modelIndices(models).get(modelId));
}
