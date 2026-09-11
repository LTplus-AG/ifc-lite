/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { appearanceAssets, modelAppearanceAssets } from './model-assets';
import type { AppearanceAssetOwner } from './assets';
import type { PageAppearancePlan } from './planner-types';
import type { AppearancePreviewImage } from './preview';

/** Adopt native atlas bytes through the shared asset registry and exact IFC URI. */
export async function adoptBakedImages(modelId: string, result: Pick<PageAppearancePlan, 'assets' | 'itemImages'>,
  owner: AppearanceAssetOwner, signal: AbortSignal) {
  const byUri = new Map<string, AppearancePreviewImage>(), assetIds: string[] = [];
  for (const output of result.assets) {
    signal.throwIfAborted();
    const asset = await appearanceAssets.add(output.png, { owner, mimeType: 'image/png', signal });
    const imageUri = modelAppearanceAssets.getAuthoredUri(modelId, asset.id);
    if (imageUri !== output.imageUri) throw new Error('The baked image identity does not match its IFC resource.');
    const bitmap = await appearanceAssets.decode(asset.id, owner, signal);
    assetIds.push(asset.id); byUri.set(imageUri, { bitmap, imageUri, repeatS: false, repeatT: false });
  }
  const itemImages = new Map<number, AppearancePreviewImage>();
  for (const item of result.itemImages) {
    const image = byUri.get(item.imageUri);
    if (!image) throw new Error('A surface is missing its baked image.');
    itemImages.set(item.geometryItemId, image);
  }
  signal.throwIfAborted();
  return { itemImages, assetIds };
}
