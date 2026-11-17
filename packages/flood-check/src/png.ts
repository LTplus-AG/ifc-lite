/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A minimal PNG decoder to straight RGBA8, for map tiles.
 *
 * It covers what WMS servers emit: 8-bit truecolour with or without alpha,
 * greyscale, and indexed colour (1/2/4/8-bit, with `tRNS`). Interlaced and
 * 16-bit images are rejected with a typed error rather than half-decoded. The
 * zlib stream is inflated with fflate (already a dependency of the parser), so
 * the same code runs in Node and in the browser without canvas.
 */

import { unzlibSync } from 'fflate';
import { HazardResponseError } from './errors.js';

export interface DecodedImage {
  width: number;
  height: number;
  /** Straight (non-premultiplied) RGBA, row-major from the top row. */
  rgba: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function chunkType(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/** Bytes per complete pixel (for filtering), rounded up to 1 for sub-byte depths. */
function channelsOf(colourType: number): number {
  switch (colourType) {
    case 0: return 1; // greyscale
    case 2: return 3; // truecolour
    case 3: return 1; // indexed
    case 4: return 2; // greyscale + alpha
    case 6: return 4; // truecolour + alpha
    default: throw new HazardResponseError(`PNG colour type ${colourType} is not supported`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode a PNG byte stream to RGBA8. Throws {@link HazardResponseError} on anything it cannot decode exactly. */
export function decodePng(bytes: Uint8Array): DecodedImage {
  if (bytes.length < 8 || SIGNATURE.some((v, i) => bytes[i] !== v)) {
    throw new HazardResponseError('response is not a PNG image');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = -1;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = u32(bytes, offset);
    const type = chunkType(bytes, offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new HazardResponseError(`PNG chunk ${type} is truncated`);
    const data = bytes.subarray(start, end);
    if (type === 'IHDR') {
      width = u32(data, 0);
      height = u32(data, 4);
      bitDepth = data[8];
      colourType = data[9];
      if (data[12] !== 0) throw new HazardResponseError('interlaced PNG is not supported');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      transparency = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4; // skip CRC
  }
  if (width <= 0 || height <= 0) throw new HazardResponseError('PNG has no IHDR');
  const channels = channelsOf(colourType);
  const subByte = colourType === 3 && (bitDepth === 1 || bitDepth === 2 || bitDepth === 4);
  if (bitDepth !== 8 && !subByte) {
    throw new HazardResponseError(`PNG bit depth ${bitDepth} with colour type ${colourType} is not supported`);
  }
  if (colourType === 3 && !palette) throw new HazardResponseError('indexed PNG has no PLTE chunk');

  let total = 0;
  for (const part of idat) total += part.length;
  const compressed = new Uint8Array(total);
  let at = 0;
  for (const part of idat) {
    compressed.set(part, at);
    at += part.length;
  }
  let raw: Uint8Array;
  try {
    raw = unzlibSync(compressed);
  } catch (error) {
    throw new HazardResponseError(`PNG image data does not inflate: ${error instanceof Error ? error.message : String(error)}`);
  }

  const stride = subByte ? Math.ceil((width * bitDepth) / 8) : width * channels;
  const bpp = subByte ? 1 : channels;
  if (raw.length < (stride + 1) * height) throw new HazardResponseError('PNG image data is shorter than its declared size');

  // tRNS on greyscale / truecolour is a single 16-bit colour key; at 8 bits the low byte is the sample.
  const colourKey = transparency && (colourType === 0 || colourType === 2)
    ? (colourType === 0 ? [transparency[1]] : [transparency[1], transparency[3], transparency[5]])
    : null;
  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  let line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    for (let x = 0; x < stride; x++) {
      const value = raw[rowStart + 1 + x];
      const left = x >= bpp ? line[x - bpp] : 0;
      const up = previous[x];
      const upLeft = x >= bpp ? previous[x - bpp] : 0;
      let out: number;
      switch (filter) {
        case 0: out = value; break;
        case 1: out = value + left; break;
        case 2: out = value + up; break;
        case 3: out = value + ((left + up) >> 1); break;
        case 4: out = value + paeth(left, up, upLeft); break;
        default: throw new HazardResponseError(`PNG row filter ${filter} is invalid`);
      }
      line[x] = out & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colourType === 6) {
        rgba[o] = line[x * 4]; rgba[o + 1] = line[x * 4 + 1]; rgba[o + 2] = line[x * 4 + 2]; rgba[o + 3] = line[x * 4 + 3];
      } else if (colourType === 2) {
        rgba[o] = line[x * 3]; rgba[o + 1] = line[x * 3 + 1]; rgba[o + 2] = line[x * 3 + 2];
        rgba[o + 3] = colourKey && colourKey[0] === rgba[o] && colourKey[1] === rgba[o + 1] && colourKey[2] === rgba[o + 2] ? 0 : 255;
      } else if (colourType === 0) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = line[x];
        rgba[o + 3] = colourKey && colourKey[0] === line[x] ? 0 : 255;
      } else if (colourType === 4) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = line[x * 2]; rgba[o + 3] = line[x * 2 + 1];
      } else {
        const index = subByte
          ? (line[(x * bitDepth) >> 3] >> (8 - bitDepth - ((x * bitDepth) & 7))) & ((1 << bitDepth) - 1)
          : line[x];
        const pal = palette as Uint8Array;
        if (index * 3 + 2 >= pal.length) throw new HazardResponseError(`PNG palette index ${index} is out of range`);
        rgba[o] = pal[index * 3]; rgba[o + 1] = pal[index * 3 + 1]; rgba[o + 2] = pal[index * 3 + 2];
        rgba[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      }
    }
    const swap = previous;
    previous = line;
    line = swap;
  }
  return { width, height, rgba };
}
