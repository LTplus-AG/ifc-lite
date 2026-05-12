/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LAS (ASPRS LAS 1.0–1.4) reader.
 *
 * Phase 1 covers Point Data Record Formats 0/1/2/3 — the legacy compact
 * formats that account for ~99% of files in the wild. Formats 6–10
 * (LAS 1.4 extended) decode similarly but use 64-bit point counts and a
 * 30-byte base record; we add them here without forking a separate file.
 *
 * Coordinates: stored as int32 with per-axis scale + offset. Real units
 * are `(raw * scale) + offset` per axis. Bounding box is read directly
 * from the header.
 *
 * RGB: present in formats 2, 3, 5, 7, 8, 10. Channels are u16 (0..65535).
 * Many real-world files store 8-bit values in the low byte and leave the
 * high byte at 0 — the spec calls this out as "scaled to 16-bit" but
 * lots of converters get it wrong. We auto-detect by checking the max
 * channel value across the whole file and rescale on the fly when needed.
 */

import type { DecodedPointChunk, PointCloudBBox } from '../types.js';

const MAGIC = 0x4653414c; // "LASF" little-endian

/** Public-Header Block (PHB) fields we use. */
export interface LasHeader {
  versionMajor: number;
  versionMinor: number;
  headerSize: number;
  /** Byte offset to the first Point Data Record. */
  pointDataOffset: number;
  numberOfVlrs: number;
  pointDataFormatId: number;
  /** Bytes per point record (header value, may be larger than the spec
   *  baseline if the producer added Extra Bytes). */
  pointRecordLength: number;
  pointCount: number;
  scale: [number, number, number];
  offset: [number, number, number];
  bbox: PointCloudBBox;
  hasGpsTime: boolean;
  hasRgb: boolean;
}

/** Spec-defined baseline record sizes (bytes), keyed by point format. */
const BASE_RECORD_SIZE: Record<number, number> = {
  0: 20, 1: 28, 2: 26, 3: 34, 4: 57, 5: 63,
  6: 30, 7: 36, 8: 38, 9: 59, 10: 67,
};

const HAS_GPS = new Set([1, 3, 4, 5, 6, 7, 8, 9, 10]);
const HAS_RGB = new Set([2, 3, 5, 7, 8, 10]);

export function parseLasHeader(buffer: ArrayBuffer | Uint8Array): LasHeader {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 227) {
    throw new Error('LAS: header truncated');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) {
    throw new Error('LAS: bad magic — expected "LASF"');
  }
  const versionMajor = view.getUint8(24);
  const versionMinor = view.getUint8(25);
  const headerSize = view.getUint16(94, true);
  const pointDataOffset = view.getUint32(96, true);
  const numberOfVlrs = view.getUint32(100, true);
  // High 4 bits of point format byte are LAS 1.4 flags (compression etc.) — mask them off.
  const pointDataFormatId = view.getUint8(104) & 0x3f;
  const pointRecordLength = view.getUint16(105, true);

  // LAS 1.0–1.3 carry the legacy 32-bit count at offset 107.
  // LAS 1.4 adds a 64-bit count at offset 247; the legacy field may be 0
  // for files with > 4 billion points or producers that strictly follow 1.4.
  const legacyCount = view.getUint32(107, true);
  let pointCount = legacyCount;
  if (versionMajor >= 1 && versionMinor >= 4 && bytes.length >= 255) {
    const fullCount = readU64LE(view, 247);
    if (fullCount > 0) pointCount = fullCount;
  }
  if (!Number.isFinite(pointCount) || pointCount < 0) {
    throw new Error('LAS: invalid point count');
  }

  const scale: [number, number, number] = [
    view.getFloat64(131, true),
    view.getFloat64(139, true),
    view.getFloat64(147, true),
  ];
  const offset: [number, number, number] = [
    view.getFloat64(155, true),
    view.getFloat64(163, true),
    view.getFloat64(171, true),
  ];
  const maxX = view.getFloat64(179, true);
  const minX = view.getFloat64(187, true);
  const maxY = view.getFloat64(195, true);
  const minY = view.getFloat64(203, true);
  const maxZ = view.getFloat64(211, true);
  const minZ = view.getFloat64(219, true);
  const bbox: PointCloudBBox = {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };

  if (BASE_RECORD_SIZE[pointDataFormatId] === undefined) {
    throw new Error(`LAS: unsupported point data format ${pointDataFormatId}`);
  }
  const baseSize = BASE_RECORD_SIZE[pointDataFormatId];
  if (pointRecordLength < baseSize) {
    throw new Error(
      `LAS: header point-record length (${pointRecordLength}) smaller than ` +
      `format ${pointDataFormatId} baseline (${baseSize})`,
    );
  }

  return {
    versionMajor,
    versionMinor,
    headerSize,
    pointDataOffset,
    numberOfVlrs,
    pointDataFormatId,
    pointRecordLength,
    pointCount,
    scale,
    offset,
    bbox,
    hasGpsTime: HAS_GPS.has(pointDataFormatId),
    hasRgb: HAS_RGB.has(pointDataFormatId),
  };
}

/**
 * Decode `count` consecutive point records into a chunk.
 *
 * `bytes` is the slice of the full file starting AT the first point we
 * want to decode (not at the file's pointDataOffset). Caller is expected
 * to have advanced past the header / VLRs.
 *
 * `stride` should equal `header.pointRecordLength`. We honour any extra
 * bytes the producer tacked on by skipping them.
 */
export function decodeLasPoints(
  bytes: Uint8Array,
  header: LasHeader,
  count: number,
  stride: number = header.pointRecordLength,
  rgbScale: number = 1,
): DecodedPointChunk {
  if (bytes.length < count * stride) {
    throw new Error(
      `LAS: decode expects ${count * stride} bytes, got ${bytes.length}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const positions = new Float32Array(count * 3);
  const intensities = new Uint16Array(count);
  const classifications = new Uint8Array(count);
  const colors = header.hasRgb ? new Float32Array(count * 3) : undefined;

  // Format-specific RGB offsets (relative to the start of a point record)
  const rgbOffset = rgbOffsetForFormat(header.pointDataFormatId);
  // LAS 1.4 extended formats (6–10) put classification at byte 16 instead of 15.
  const classOffset = header.pointDataFormatId >= 6 ? 16 : 15;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < count; i++) {
    const base = i * stride;
    const x = view.getInt32(base, true) * header.scale[0] + header.offset[0];
    const y = view.getInt32(base + 4, true) * header.scale[1] + header.offset[1];
    const z = view.getInt32(base + 8, true) * header.scale[2] + header.offset[2];
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;

    intensities[i] = view.getUint16(base + 12, true);
    // LAS 1.4 (formats 6+) stores classification in a dedicated byte.
    // Older formats pack classification into the low 5 bits of byte 15
    // (high 3 bits are synthetic / key-point / withheld flags).
    classifications[i] = header.pointDataFormatId >= 6
      ? view.getUint8(base + classOffset)
      : view.getUint8(base + classOffset) & 0x1f;

    if (colors && rgbOffset >= 0) {
      const r = view.getUint16(base + rgbOffset, true);
      const g = view.getUint16(base + rgbOffset + 2, true);
      const b = view.getUint16(base + rgbOffset + 4, true);
      colors[i * 3] = (r * rgbScale) / 65535;
      colors[i * 3 + 1] = (g * rgbScale) / 65535;
      colors[i * 3 + 2] = (b * rgbScale) / 65535;
    }
  }

  return {
    positions,
    colors,
    classifications,
    intensities,
    pointCount: count,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}

/** Sample up to `samples` RGB triples; return the max channel value seen.
 *  Used to detect "8-bit RGB stuffed into low byte of u16" producers. */
export function sampleMaxRgbChannel(
  bytes: Uint8Array,
  header: LasHeader,
  samples: number = 1024,
): number {
  if (!header.hasRgb) return 0;
  const stride = header.pointRecordLength;
  const total = Math.min(header.pointCount, Math.floor(bytes.length / stride));
  if (total === 0) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rgbOff = rgbOffsetForFormat(header.pointDataFormatId);
  if (rgbOff < 0) return 0;
  const step = Math.max(1, Math.floor(total / Math.min(samples, total)));
  let max = 0;
  for (let i = 0; i < total; i += step) {
    const base = i * stride;
    const r = view.getUint16(base + rgbOff, true);
    const g = view.getUint16(base + rgbOff + 2, true);
    const b = view.getUint16(base + rgbOff + 4, true);
    if (r > max) max = r;
    if (g > max) max = g;
    if (b > max) max = b;
  }
  return max;
}

function rgbOffsetForFormat(format: number): number {
  // Offsets where the first RGB byte sits in the point record.
  switch (format) {
    case 2: return 20;
    case 3: return 28;
    case 5: return 28;
    case 7: return 30;
    case 8: return 30;
    case 10: return 30;
    default: return -1;
  }
}

function readU64LE(view: DataView, offset: number): number {
  // No bigint round-trip: point counts > 2^53 are absurd in practice.
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  return hi * 0x100000000 + lo;
}
