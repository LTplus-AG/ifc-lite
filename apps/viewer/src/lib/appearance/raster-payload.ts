/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { appearanceAssets } from './model-assets';
import type { AppearanceAssetOwner } from './assets';
import type { AppearanceRaster } from './planner-types';
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

/** Read retained image pixels only; Rust owns all projection and sampling. */
/** `sourceAssetId` is null when the source carries its colours per point (#4381):
 * the payload then holds only the target's existing rasters and `sourceImage` is null. */
export async function prepareAppearanceRasterPayload(modelId: string, productIds: readonly number[], sourceAssetId: string | null,
  owner: AppearanceAssetOwner, signal: AbortSignal, validate: () => void) {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  function add(width: number, height: number, read: () => Uint8Array): AppearanceRaster {
    const size = width * height * 4;
    if (!Number.isSafeInteger(size) || size <= 0 || byteLength + size > MAX_INPUT_BYTES) {
      throw new Error('Source and surface images exceed the 64 MiB appearance budget. Choose a smaller scope or lower image quality.');
    }
    const bytes = read();
    if (bytes.byteLength !== size) throw new Error('An appearance image has incomplete pixels. Reload its source.');
    const raster = { width, height, byteOffset: byteLength, byteLength: size };
    chunks.push(bytes); byteLength += size;
    return raster;
  }
  function fromBitmap(bitmap: ImageBitmap): AppearanceRaster {
    return add(bitmap.width, bitmap.height, () => {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('This browser cannot read source image pixels.');
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    });
  }
  let sourceImage: AppearanceRaster | null = null;
  if (sourceAssetId !== null) {
    appearanceAssets.retain(sourceAssetId, owner);
    sourceImage = fromBitmap(await appearanceAssets.decode(sourceAssetId, owner, signal));
  }
  const images = new Map<string, AppearanceRaster>();
  const state = useViewerStore.getState();
  const selected = new Set(productIds.map(id => state.toGlobalId(modelId, id)));
  // Read committed model meshes. Scene pieces may currently show an older draft;
  // those pixels/URLs must never become the original IFC appearance for a new bake.
  const meshes = state.models.get(modelId)?.geometryResult?.meshes ?? [];
  for (const mesh of meshes) {
    if (!selected.has(mesh.expressId) && !mesh.entityIds?.some(id => selected.has(id))) continue;
    signal.throwIfAborted();
    const uri = mesh.textureRef?.url;
    if (!uri || images.has(uri)) continue;
    if (images.size >= 256) throw new Error('This scope uses too many source images. Choose a smaller group of objects.');
    if (mesh.textureBitmap) images.set(uri, fromBitmap(mesh.textureBitmap));
    else if (mesh.texture) {
      const texture = mesh.texture;
      images.set(uri, add(texture.width, texture.height, () => new Uint8Array(texture.rgba)));
    } else throw new Error(`The surface image ${uri.slice(0, 120)} is not loaded. Wait for textures before preparing appearance.`);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  signal.throwIfAborted(); validate();
  const rgba = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { rgba.set(chunk, offset); offset += chunk.byteLength; }
  return { sourceImage, sourceImages: [...images].map(([imageUri, raster]) => ({ imageUri, raster })), rgba };
}
