/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Versioned transport of already resolved mesh appearance; not a USD schema. */
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { IfcxSchema } from './types.js';

export const IFCX_APPEARANCE = 'ifclite::appearance::v1';
export const IFCX_IMAGE = 'ifclite::image::v1';
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;
const MAX_DIMENSION = 16_384;

export interface IfcxEncodedImage { mimeType: 'image/png' | 'image/jpeg'; bytes: Uint8Array }

export interface IfcxPixels {
  /** Optional original source bytes, retained without decoding or recompression. */
  original?: IfcxEncodedImage;
  width: number;
  height: number;
  rgba: Uint8Array;
  repeatS: boolean;
  repeatT: boolean;
}

export interface IfcxAppearance {
  image: { ref: string };
  uvs: number[];
  repeatS: boolean;
  repeatT: boolean;
}

export interface IfcxImage {
  original?: { mimeType: 'image/png' | 'image/jpeg'; data: string };
  width: number;
  height: number;
  /** Straight-alpha, top-down RGBA8. Base64 is transport, not a color conversion. */
  rgba: string;
}

/** Inline declarations: readers without this extension still see standard geometry. */
export const IFCX_APPEARANCE_SCHEMAS: Record<string, IfcxSchema> = {
  [IFCX_APPEARANCE]: { value: { dataType: 'Object', objectRestrictions: { values: {
    image: { dataType: 'Reference' },
    uvs: { dataType: 'Array', arrayRestrictions: { value: { dataType: 'Real' } } },
    repeatS: { dataType: 'Boolean' }, repeatT: { dataType: 'Boolean' },
  } } } },
  [IFCX_IMAGE]: { value: { dataType: 'Object', objectRestrictions: { values: {
    width: { dataType: 'Integer' }, height: { dataType: 'Integer' },
    rgba: { dataType: 'String' },
    original: { optional: true, dataType: 'Object', objectRestrictions: { values: {
      mimeType: { dataType: 'Enum', enumRestrictions: { options: ['image/png', 'image/jpeg'] } },
      data: { dataType: 'String' },
    } } },
  } } } },
};

function byteLength(width: unknown, height: unknown): number {
  if (typeof width !== 'number' || typeof height !== 'number'
    || !Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION
    || width * height * 4 > MAX_IMAGE_BYTES) {
    throw new Error('IFCX image exceeds the supported dimensions or 512 MiB pixel budget.');
  }
  return width * height * 4;
}

export function encodeIfcxImage(pixels: IfcxPixels): { key: string; value: IfcxImage } {
  const size = byteLength(pixels.width, pixels.height);
  if (pixels.rgba.length !== size) throw new Error('IFCX image pixel length does not match its dimensions.');
  const chunks: string[] = [];
  for (let i = 0; i < size; i += 24_576) {
    chunks.push(btoa(String.fromCharCode(...pixels.rgba.subarray(i, i + 24_576))));
  }
  const original = pixels.original;
  if (original) validateOriginal(original);
  return {
    key: `${original ? bytesToHex(blake3(original.bytes)) : 'rgba'}-${pixels.width}x${pixels.height}-${bytesToHex(blake3(pixels.rgba))}`,
    value: { width: pixels.width, height: pixels.height, rgba: chunks.join(''),
      ...(original ? { original: { mimeType: original.mimeType, data: encodeBytes(original.bytes) } } : {}) },
  };
}

/** One decoder per file, shared across occurrences, with an aggregate allocation budget. */
export function createIfcxImageDecoder(): (path: string, value: unknown) => Omit<IfcxPixels, 'repeatS' | 'repeatT'> {
  const cache = new Map<string, Omit<IfcxPixels, 'repeatS' | 'repeatT'>>();
  let allocated = 0;
  return (path, value) => {
    const cached = cache.get(path);
    if (cached) return cached;
    if (!value || typeof value !== 'object') throw new Error('IFCX appearance references a missing image.');
    const image = value as Partial<IfcxImage>;
    const size = byteLength(image.width, image.height);
    if (typeof image.rgba !== 'string' || image.rgba.length !== Math.ceil(size / 3) * 4
      || allocated + size > MAX_IMAGE_BYTES) throw new Error('IFCX image data is invalid or exceeds the 512 MiB file pixel budget.');
    // Validate before allocating. The alphabet also excludes whitespace accepted by atob.
    const padding = (3 - size % 3) % 3;
    for (let i = 0; i < image.rgba.length; i++) {
      const c = image.rgba.charCodeAt(i);
      const valid = i >= image.rgba.length - padding ? c === 61
        : (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;
      if (!valid) throw new Error('IFCX image is not canonical base64.');
    }
    const rgba = new Uint8Array(size);
    let offset = 0;
    for (let i = 0; i < image.rgba.length; i += 32_768) {
      const encoded = image.rgba.slice(i, i + 32_768);
      const chunk = atob(encoded);
      if (btoa(chunk) !== encoded) throw new Error('IFCX image is not canonical base64.');
      for (let j = 0; j < chunk.length; j++) rgba[offset++] = chunk.charCodeAt(j);
    }
    if (offset !== size) throw new Error('IFCX decoded image length does not match its dimensions.');
    let original: IfcxEncodedImage | undefined;
    if (image.original !== undefined) {
      const source = image.original;
      if (!source || (source.mimeType !== 'image/png' && source.mimeType !== 'image/jpeg')
        || typeof source.data !== 'string' || source.data.length > 4 * Math.ceil(64 * 1024 * 1024 / 3)
        || allocated + size + Math.floor(source.data.length / 4) * 3 > MAX_IMAGE_BYTES) {
        throw new Error('IFCX original image exceeds the 64 MiB resource budget.');
      }
      const raw = atob(source.data);
      if (btoa(raw) !== source.data) throw new Error('IFCX original image is not canonical base64.');
      const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
      original = { mimeType: source.mimeType, bytes };
      validateOriginal(original);
      if (allocated + size + bytes.length > MAX_IMAGE_BYTES) throw new Error('IFCX original images exceed the file pixel/resource budget.');
      allocated += bytes.length;
    }
    const pixels = { width: image.width!, height: image.height!, rgba, ...(original ? { original } : {}) };
    allocated += size;
    cache.set(path, pixels);
    return pixels;
  };
}

export function decodeIfcxAppearance(value: unknown, vertexCount: number): IfcxAppearance {
  if (!value || typeof value !== 'object') throw new Error('Invalid IFCX appearance.');
  const appearance = value as Partial<IfcxAppearance>;
  if (!appearance.image || typeof appearance.image.ref !== 'string'
    || typeof appearance.repeatS !== 'boolean' || typeof appearance.repeatT !== 'boolean'
    || !Array.isArray(appearance.uvs) || appearance.uvs.length !== vertexCount * 2
    || !appearance.uvs.every((uv) => typeof uv === 'number' && Number.isFinite(uv) && Math.abs(uv) <= 3.4028234663852886e38)) {
    throw new Error('IFCX appearance must provide a finite UV pair per mesh vertex, an image reference and sampler wraps.');
  }
  return appearance as IfcxAppearance;
}

function encodeBytes(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 24_576) chunks.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 24_576))));
  return chunks.join('');
}

function validateOriginal(source: IfcxEncodedImage): void {
  const bytes = source.bytes;
  if (bytes.length > 64 * 1024 * 1024 || !(source.mimeType === 'image/png'
    ? bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)
    : source.mimeType === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)) {
    throw new Error('IFCX original image must contain bounded PNG or JPEG source bytes matching its MIME type.');
  }
}
