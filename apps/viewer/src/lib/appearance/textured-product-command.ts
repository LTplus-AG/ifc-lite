/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Renderer } from '@ifc-lite/renderer';
import { commitAuthoredProduct } from './authored-product-command';
import type { captureAppearanceSource, AppearanceCommitOptions } from './command';
import type { TexturedProductPlan } from './textured-product-types';

/** Image and scan callers use the same multi-part IFC/GPU/history transaction. */
export function commitTexturedProduct(modelId: string, assetId: string, native: TexturedProductPlan,
  containerId: number, renderer: Renderer, source: ReturnType<typeof captureAppearanceSource>,
  options: AppearanceCommitOptions = {}) {
  if (native.geometryItemId !== native.mesh.geometry_item_id) throw new Error('Invalid native annotation geometry.');
  return commitAuthoredProduct(modelId, [assetId], { ...native, meshes: [native.mesh] }, containerId, renderer, source, options);
}
