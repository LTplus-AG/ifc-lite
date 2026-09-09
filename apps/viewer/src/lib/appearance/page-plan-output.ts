/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PageAppearancePlan } from './planner-types.js';

/** Decode the native bounded binary envelope without base64 or JSON pixel arrays.
 * Detached PNG buffers avoid retaining every other atlas when one asset survives. */
export function decodePagePlan(bytes: Uint8Array): PageAppearancePlan {
  if (bytes.length < 8 || bytes.length > 160 * 1024 * 1024
    || bytes[0] !== 73 || bytes[1] !== 70 || bytes[2] !== 80 || bytes[3] !== 65) {
    throw new Error('Invalid page appearance output envelope');
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (length > 64 * 1024 * 1024 || length > bytes.length - 8) throw new Error('Invalid page metadata length');
  type Metadata = Omit<PageAppearancePlan, 'assets'> & { assets: Array<{
    imageUri: string; width: number; height: number; byteOffset: number; byteLength: number;
  }> };
  const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, 8 + length))) as Metadata;
  if (!metadata || !Array.isArray(metadata.assets) || metadata.assets.length > 10_000
    || !Array.isArray(metadata.itemImages) || !metadata.plan) throw new Error('Invalid page metadata');
  const start = 8 + length;
  let cursor = 0, pixels = 0;
  for (const asset of metadata.assets) {
    if (!Number.isSafeInteger(asset.byteOffset) || asset.byteOffset !== cursor
      || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 1
      || asset.byteLength > bytes.length - start - cursor
      || !Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height)
      || asset.width < 1 || asset.height < 1 || asset.width > 4096 || asset.height > 4096) {
      throw new Error('Invalid page atlas range or dimensions');
    }
    pixels += asset.width * asset.height;
    if (pixels > 16_777_216) throw new Error('Page atlas output exceeds pixel budget');
    cursor += asset.byteLength;
  }
  if (start + cursor !== bytes.length) throw new Error('Unexpected page atlas trailing bytes');
  return { ...metadata, assets: metadata.assets.map(asset => ({
    imageUri: asset.imageUri, width: asset.width, height: asset.height,
    png: bytes.slice(start + asset.byteOffset, start + asset.byteOffset + asset.byteLength),
  })) };
}
