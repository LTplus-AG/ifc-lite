/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type AppearanceImageMime = 'image/png' | 'image/jpeg';

export interface AppearanceAssetLimits {
  maxImageBytes: number;
  maxDimension: number;
  maxPixels: number;
  maxEncodedBytes: number;
  maxDecodedBytes: number;
}

export const DEFAULT_APPEARANCE_ASSET_LIMITS: Readonly<AppearanceAssetLimits> = Object.freeze({
  maxImageBytes: 32 * 1024 * 1024,
  maxDimension: 8192,
  maxPixels: 16 * 1024 * 1024,
  maxEncodedBytes: 128 * 1024 * 1024,
  // Convento carries six 4096² textures (384 MiB); retain room for authoring previews.
  maxDecodedBytes: 512 * 1024 * 1024,
});

export class AppearanceAssetError extends Error {
  constructor(public readonly code: 'format' | 'size' | 'budget' | 'missing' | 'owner' | 'decode', message: string) {
    super(message);
    this.name = 'AppearanceAssetError';
  }
}

export function inspectImage(bytes: Uint8Array, claimedMime?: string): { mimeType: AppearanceImageMime; width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let result: { mimeType: AppearanceImageMime; width: number; height: number } | undefined;
  if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) {
    if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) {
      throw new AppearanceAssetError('format', 'The PNG header is damaged. Export the image again as PNG or JPEG.');
    }
    let offset = 8;
    let hasData = false;
    let ended = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12) break;
      const type = view.getUint32(offset + 4);
      if (type === 0x49444154) hasData = true;
      offset += length + 12;
      if (type === 0x49454e44) { ended = length === 0 && offset === bytes.length; break; }
    }
    if (!hasData || !ended) throw new AppearanceAssetError('format', 'The PNG is truncated or has invalid chunks. Export the image again.');
    result = { mimeType: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw new AppearanceAssetError('format', 'The JPEG is truncated. Export the image again.');
    let offset = 2;
    let hasScan = false;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (marker === 0xda) {
        const components = bytes[offset + 2];
        hasScan = !!result && components > 0 && length === 6 + 2 * components;
        break;
      }
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8 || bytes[offset + 7] === 0 || length !== 8 + 3 * bytes[offset + 7] || result) break;
        result = { mimeType: 'image/jpeg', width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      offset += length;
    }
    if (!hasScan) result = undefined;
  }
  if (!result) throw new AppearanceAssetError('format', 'Choose a valid PNG or JPEG image; this file has no supported image header.');
  const mime = claimedMime?.split(';')[0].trim().toLowerCase();
  if (mime && mime !== 'application/octet-stream' && mime !== result.mimeType) {
    throw new AppearanceAssetError('format', `The file contents are ${result.mimeType}, but its declared type is ${mime}. Export it again with the matching image format.`);
  }
  return result;
}

export function validateDimensions(width: number, height: number, limits: AppearanceAssetLimits): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new AppearanceAssetError('size', 'The image dimensions are invalid. Export the image again.');
  }
  if (width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels) {
    throw new AppearanceAssetError('size', `Resize this image: maximum edge ${limits.maxDimension}px and maximum ${limits.maxPixels} pixels.`);
  }
}
