/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { appearanceAssets, modelAppearanceAssets } from '../model-assets.js';
import type { AppearanceAssetOwner } from '../assets.js';
import type { AppearanceDraftSettings, AppearanceSourceOption } from '../draft-types.js';
import type { AppearanceSnapshot } from '../snapshot.js';
import type { createAppearancePlanner } from '../planner-worker-client.js';
import type { AppearanceRaster } from '../planner-types.js';
import type { AppearancePreviewImage } from '../preview.js';
import { appearanceMapping } from '../settings.js';
import { calibratePdfAppearance } from './calibration.js';

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
function abort(signal: AbortSignal): void { signal.throwIfAborted(); }

/** Pixel readback only. Native code owns projection, old-surface sampling and alpha composition. */
export async function preparePdfPagePreview(options: {
  snapshot: AppearanceSnapshot; productIds: number[]; source: AppearanceSourceOption;
  settings: AppearanceDraftSettings;
  planner: ReturnType<typeof createAppearancePlanner>; owner: AppearanceAssetOwner; signal: AbortSignal;
}) {
  const { snapshot, productIds, source, settings, planner, owner, signal } = options;
  const pdf = source.pdf;
  if (!pdf || !source.calibration || !source.assetId) throw new Error('Choose two page points and enter their measured distance.');
  const orientation = appearanceMapping({ ...settings, kind: 'planar' });
  if (orientation.kind !== 'planar') throw new Error('PDF pages need planar placement.');
  const normals: Record<AppearanceDraftSettings['plane'], [number, number, number]> = {
    xy: [0, 0, 1], xz: [0, -1, 0], yz: [1, 0, 0],
  };
  const calibration = await calibratePdfAppearance(pdf.recipe, source.calibration, {
    worldAnchor: orientation.origin, worldDirection: orientation.axisU, planeNormal: normals[settings.plane],
  });
  abort(signal); snapshot.validate();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  function add(width: number, height: number, read: () => Uint8Array): AppearanceRaster {
    const size = width * height * 4;
    if (!Number.isSafeInteger(size) || size <= 0 || byteLength + size > MAX_INPUT_BYTES) {
      throw new Error('Page and surface images exceed the 64 MiB projection budget. Choose a smaller scope or lower image quality.');
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
      if (!context) throw new Error('This browser cannot read page pixels for projection.');
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    });
  }
  appearanceAssets.retain(source.assetId, owner);
  const page = fromBitmap(await appearanceAssets.decode(source.assetId, owner, signal));
  const images = new Map<string, AppearanceRaster>();
  const state = useViewerStore.getState();
  const selected = new Set(productIds.map(id => state.toGlobalId(snapshot.modelId, id)));
  // Read committed model meshes. Scene pieces may currently show an older draft;
  // those pixels/URLs must never become the original IFC appearance for a new bake.
  const meshes = state.models.get(snapshot.modelId)?.geometryResult?.meshes ?? [];
  for (const mesh of meshes) {
    if (!selected.has(mesh.expressId) && !mesh.entityIds?.some(id => selected.has(id))) continue;
    abort(signal);
    const uri = mesh.textureRef?.url;
    if (!uri || images.has(uri)) continue;
    if (images.size >= 256) throw new Error('This scope uses too many source images. Project onto a smaller group of objects.');
    if (mesh.textureBitmap) images.set(uri, fromBitmap(mesh.textureBitmap));
    else if (mesh.texture) {
      const texture = mesh.texture;
      images.set(uri, add(texture.width, texture.height, () => new Uint8Array(texture.rgba)));
    } else throw new Error(`The surface image ${uri.slice(0, 120)} is not loaded. Wait for textures before projecting a page.`);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  abort(signal); snapshot.validate();
  const rgba = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { rgba.set(chunk, offset); offset += chunk.byteLength; }
  const result = await planner.pagePlan(snapshot.bytes, {
    appearance: { schema: snapshot.schema, sourceRevision: snapshot.revision, nextExpressId: snapshot.nextExpressId,
      productIds, imageUri: modelAppearanceAssets.getAuthoredUri(snapshot.modelId, source.assetId),
      repeatS: false, repeatT: false, mapping: calibration.mapping },
    page, sourceImages: [...images].map(([imageUri, raster]) => ({ imageUri, raster })),
    texelsPerMetre: Math.max(pdf.recipe.pixelWidth / calibration.mapping.metresPerTile[0],
      pdf.recipe.pixelHeight / calibration.mapping.metresPerTile[1]),
  }, rgba, { signal });
  abort(signal); snapshot.validate();
  const byUri = new Map<string, AppearancePreviewImage>();
  const assetIds: string[] = [];
  for (const output of result.assets) {
    abort(signal);
    const asset = await appearanceAssets.add(output.png, { owner, mimeType: 'image/png', signal });
    const imageUri = modelAppearanceAssets.getAuthoredUri(snapshot.modelId, asset.id);
    if (imageUri !== output.imageUri) throw new Error('The projected image identity does not match its IFC resource.');
    const bitmap = await appearanceAssets.decode(asset.id, owner, signal);
    assetIds.push(asset.id); byUri.set(imageUri, { bitmap, imageUri, repeatS: false, repeatT: false });
  }
  const itemImages = new Map<number, AppearancePreviewImage>();
  for (const item of result.itemImages) {
    const image = byUri.get(item.imageUri);
    if (!image) throw new Error('A projected surface is missing its baked image.');
    itemImages.set(item.geometryItemId, image);
  }
  abort(signal); snapshot.validate();
  return { plan: result.plan, itemImages, assetIds };
}
