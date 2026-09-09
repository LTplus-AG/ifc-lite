/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { attachTextureBitmaps, type TextureBitmapStore } from '@/utils/textureResources.js';

import { parseGlbViewerModel } from './viewerModelIngest.js';

export async function prepareGlbViewerModel(buffer: ArrayBuffer, decode: (archive: { originalResources: Map<string, Uint8Array> }) => Promise<TextureBitmapStore | null>, isStale: () => boolean) {
  const result = await parseGlbViewerModel(buffer);
  const bitmaps = await decode({ originalResources: result.originalResources ?? new Map() });
  if (isStale()) return null;
  validateOpaqueGlbImages(bitmaps);
  attachTextureBitmaps(result.geometryResult.meshes, bitmaps);
  for (const mesh of result.geometryResult.meshes) {
    if (mesh.textureRef && !mesh.textureBitmap) throw new Error('GLB: embedded texture could not be decoded');
  }
  return result;
}

/** The current textured renderer only supports opaque captured surfaces. */
export function validateOpaqueGlbImages(bitmaps: TextureBitmapStore | null): void {
  for (const bitmap of new Set(bitmaps?.values())) {
    // Scan a row at a time: no second full-image RGBA allocation for large scans.
    const canvas = new OffscreenCanvas(bitmap.width, 1);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('GLB: cannot validate texture opacity');
    for (let y = 0; y < bitmap.height; y++) {
      context.clearRect(0, 0, bitmap.width, 1);
      context.drawImage(bitmap, 0, y, bitmap.width, 1, 0, 0, bitmap.width, 1);
      const rgba = context.getImageData(0, 0, bitmap.width, 1).data;
      for (let i = 3; i < rgba.length; i += 4) {
        if (rgba[i] !== 255) throw new Error('GLB: images with transparent pixels require unsupported material alpha semantics');
      }
    }
    canvas.width = 0;
  }
}
