/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore, type FederatedModel } from '@/store';
import type { GaussianSplatApi, GaussianSplatBounds, GaussianSplatHandle } from '@ifc-lite/renderer';

interface OwnedAsset { handle: GaussianSplatHandle; splats: GaussianSplatApi; visible?: boolean }

/** modelId -> the exact renderer-issued handle its model was published with. */
const owned = new Map<string, OwnedAsset>();
let subscribed = false;

/**
 * Publication hands a capture to its model; from then on the store alone
 * decides its lifetime (#8565). Every models change reconciles synchronously,
 * so removal, replacement, a primary reload and clear free the renderer asset
 * in the same tick, and model visibility/isolate mirror onto it.
 */
export function adoptGaussianAsset(modelId: string, handle: GaussianSplatHandle, splats: GaussianSplatApi): void {
  owned.set(modelId, { handle, splats });
  if (!subscribed) {
    subscribed = true;
    useViewerStore.subscribe((state, previous) => {
      if (state.models !== previous.models) reconcileGaussianAssets(state.models);
    });
  }
  reconcileGaussianAssets(useViewerStore.getState().models);
}

export function reconcileGaussianAssets(models: ReadonlyMap<string, FederatedModel>): void {
  for (const [modelId, asset] of owned) {
    const model = models.get(modelId);
    if (model?.gaussianSplat?.handle !== asset.handle) {
      owned.delete(modelId);
      asset.splats.remove(asset.handle);
      continue;
    }
    if (asset.visible !== model.visible) {
      asset.visible = model.visible;
      asset.splats.setVisible(asset.handle, model.visible);
    }
  }
}

/** Centre bounds of one capture, in the camera-fit frame. Framing only. */
export function gaussianModelBounds(model: FederatedModel): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
  const asset = owned.get(model.id);
  if (!asset || asset.handle !== model.gaussianSplat?.handle) return null;
  return toBox(asset.splats.getBounds(asset.handle));
}

function toBox(bounds: GaussianSplatBounds | null) {
  if (!bounds) return null;
  const [x0, y0, z0] = bounds.min, [x1, y1, z1] = bounds.max;
  return { min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } };
}

/** The renderer's own lifecycle state for a published capture. */
export function gaussianModelState(model: FederatedModel) {
  const asset = owned.get(model.id);
  return asset && asset.handle === model.gaussianSplat?.handle ? asset.splats.getState(asset.handle) : { state: 'invalid' as const };
}
