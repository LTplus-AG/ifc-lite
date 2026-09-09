/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { attachTextureBitmaps, type TextureBitmapStore } from '@/utils/textureResources.js';

import { parseGlbViewerModel } from './viewerModelIngest.js';

export async function prepareGlbViewerModel(buffer: ArrayBuffer, decode: (archive: { originalResources: Map<string, Uint8Array> }) => Promise<TextureBitmapStore | null>, isStale: () => boolean) {
  const result = await parseGlbViewerModel(buffer);
  const bitmaps = await decode({ originalResources: result.originalResources ?? new Map() });
  if (isStale()) return null;
  if (!await validateOpaqueGlbImages(bitmaps, isStale)) return null;
  attachTextureBitmaps(result.geometryResult.meshes, bitmaps);
  for (const mesh of result.geometryResult.meshes) {
    if (mesh.textureRef && !mesh.textureBitmap) throw new Error('GLB: embedded texture could not be decoded');
  }
  return result;
}

/** The current textured renderer only supports opaque captured surfaces. */
export async function validateOpaqueGlbImages(bitmaps: TextureBitmapStore | null, isStale: () => boolean): Promise<boolean> {
  const seen = new Set<ImageBitmap>();
  for (const [path, bitmap] of bitmaps ?? []) {
    if (seen.has(bitmap) || /\.jpe?g$/i.test(path)) continue; // JPEG has no alpha channel.
    seen.add(bitmap);
    // Bounded readback strips, rather than a second full-image RGBA allocation.
    const stripHeight = Math.min(64, bitmap.height);
    const canvas = new OffscreenCanvas(bitmap.width, stripHeight);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('GLB: cannot validate texture opacity');
    let lastYield = performance.now();
    try {
      for (let y = 0; y < bitmap.height; y += stripHeight) {
        if (isStale()) return false;
        const height = Math.min(stripHeight, bitmap.height - y);
        context.clearRect(0, 0, bitmap.width, stripHeight);
        context.drawImage(bitmap, 0, y, bitmap.width, height, 0, 0, bitmap.width, height);
        const rgba = context.getImageData(0, 0, bitmap.width, height).data;
        for (let i = 3; i < rgba.length; i += 4) {
          if (rgba[i] !== 255) throw new Error('GLB: images with transparent pixels require unsupported material alpha semantics');
        }
        if (performance.now() - lastYield > 16) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          lastYield = performance.now();
        }
      }
    } finally { canvas.width = 0; }
  }
  return !isStale();
}
