/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PCD (Point Cloud Data, PCL library format) decoder.
 *
 * Supports DATA ascii / binary / binary_compressed (LZF). Extracts at minimum
 * x/y/z (required) and optionally rgb (PCL packs RGB as a bit-reinterpreted
 * 32-bit field — we read the bits regardless of the declared TYPE).
 *
 * binary_compressed payload layout: u32-LE compressedSize, u32-LE
 * uncompressedSize, then LZF-compressed data. The decompressed body is
 * COLUMN-major (SoA), unlike `binary` which is row-major (AoS).
 */

import { decompressLZF } from '../lzf.js';
import type { DecodedPointChunk, PointCloudBBox } from '../types.js';

interface PcdField {
  name: string;
  size: number;       // bytes per element (1, 2, 4, 8)
  type: 'F' | 'I' | 'U';
  count: number;      // elements per record (typically 1)
  offset: number;     // byte offset within a row-major record
}

interface PcdHeader {
  version: string;
  fields: PcdField[];
  width: number;
  height: number;
  pointCount: number;
  pointStride: number;
  data: 'ascii' | 'binary' | 'binary_compressed';
  bodyOffset: number;
}

const TEXT_DECODER = new TextDecoder();

export function decodePcd(buffer: Uint8Array): DecodedPointChunk {
  const header = parseHeader(buffer);

  let positions: Float32Array;
  let colors: Float32Array | undefined;

  if (header.data === 'ascii') {
    ({ positions, colors } = decodeAscii(buffer, header));
  } else if (header.data === 'binary') {
    ({ positions, colors } = decodeBinary(buffer, header));
  } else {
    ({ positions, colors } = decodeBinaryCompressed(buffer, header));
  }

  return {
    positions,
    colors,
    pointCount: header.pointCount,
    bbox: computeBBox(positions),
  };
}

// ─── header parser ──────────────────────────────────────────────────────────

function parseHeader(buffer: Uint8Array): PcdHeader {
  // Header is ASCII, terminated by the line beginning with "DATA ".
  // Decode a generous slice (PCD headers are tiny — < 1 KB even with comments).
  const probeLen = Math.min(2048, buffer.length);
  const probe = TEXT_DECODER.decode(buffer.subarray(0, probeLen));

  const dataIdx = probe.search(/^DATA\s+(\S+)/m);
  if (dataIdx < 0) {
    throw new Error('PCD: missing DATA line in header');
  }
  const headerText = probe.slice(0, dataIdx);
  const dataLineMatch = probe.slice(dataIdx).match(/^DATA\s+(\S+)\s*\n/);
  if (!dataLineMatch) {
    throw new Error('PCD: malformed DATA line');
  }
  const dataKind = dataLineMatch[1].toLowerCase();
  if (dataKind !== 'ascii' && dataKind !== 'binary' && dataKind !== 'binary_compressed') {
    throw new Error(`PCD: unsupported DATA kind "${dataKind}"`);
  }
  const bodyOffset = dataIdx + dataLineMatch[0].length;

  // Parse named tokens out of the header.
  const tokens = new Map<string, string[]>();
  for (const rawLine of headerText.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    tokens.set(key, parts.slice(1));
  }

  const fieldNames = tokens.get('FIELDS') ?? [];
  const sizes = (tokens.get('SIZE') ?? []).map(Number);
  const types = (tokens.get('TYPE') ?? []) as Array<'F' | 'I' | 'U'>;
  const counts = (tokens.get('COUNT') ?? []).map(Number);
  const widthRaw = tokens.get('WIDTH')?.[0];
  const heightRaw = tokens.get('HEIGHT')?.[0];
  const pointsRaw = tokens.get('POINTS')?.[0];

  if (fieldNames.length === 0) throw new Error('PCD: missing FIELDS');
  if (sizes.length !== fieldNames.length) throw new Error('PCD: SIZE/FIELDS length mismatch');
  if (types.length !== fieldNames.length) throw new Error('PCD: TYPE/FIELDS length mismatch');

  const fields: PcdField[] = [];
  let stride = 0;
  for (let i = 0; i < fieldNames.length; i++) {
    const count = counts[i] ?? 1;
    const size = sizes[i];
    const type = types[i];
    if (type !== 'F' && type !== 'I' && type !== 'U') {
      throw new Error(`PCD: unsupported field TYPE "${type}"`);
    }
    fields.push({ name: fieldNames[i], size, type, count, offset: stride });
    stride += size * count;
  }

  const width = widthRaw !== undefined ? parseInt(widthRaw, 10) : 0;
  const height = heightRaw !== undefined ? parseInt(heightRaw, 10) : 1;
  const pointCount = pointsRaw !== undefined ? parseInt(pointsRaw, 10) : width * height;
  if (!Number.isFinite(pointCount) || pointCount <= 0) {
    throw new Error('PCD: invalid point count');
  }

  return {
    version: tokens.get('VERSION')?.[0] ?? '0.7',
    fields,
    width,
    height,
    pointCount,
    pointStride: stride,
    data: dataKind as PcdHeader['data'],
    bodyOffset,
  };
}

// ─── decoders ───────────────────────────────────────────────────────────────

interface ChannelPlan {
  xField?: PcdField;
  yField?: PcdField;
  zField?: PcdField;
  rgbField?: PcdField;
}

function planChannels(header: PcdHeader): ChannelPlan {
  const plan: ChannelPlan = {};
  for (const field of header.fields) {
    const name = field.name.toLowerCase();
    if (name === 'x') plan.xField = field;
    else if (name === 'y') plan.yField = field;
    else if (name === 'z') plan.zField = field;
    else if (name === 'rgb' || name === 'rgba') plan.rgbField = field;
  }
  if (!plan.xField || !plan.yField || !plan.zField) {
    throw new Error('PCD: x/y/z fields are required');
  }
  return plan;
}

function decodeAscii(buffer: Uint8Array, header: PcdHeader): { positions: Float32Array; colors?: Float32Array } {
  const plan = planChannels(header);
  const text = TEXT_DECODER.decode(buffer.subarray(header.bodyOffset));
  const positions = new Float32Array(header.pointCount * 3);
  const colors = plan.rgbField ? new Float32Array(header.pointCount * 3) : undefined;

  // Column index of x/y/z/rgb in the ascii row order (ascii rows preserve
  // FIELDS order; multi-count fields are flattened).
  const colMap = buildAsciiColumnMap(header, plan);

  let writeIdx = 0;
  let lineStart = 0;
  let pointsRead = 0;
  while (pointsRead < header.pointCount && lineStart < text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd).trim();
    lineStart = lineEnd + 1;
    if (!line) continue;
    const parts = line.split(/\s+/);
    positions[writeIdx * 3] = Number(parts[colMap.xCol]);
    positions[writeIdx * 3 + 1] = Number(parts[colMap.yCol]);
    positions[writeIdx * 3 + 2] = Number(parts[colMap.zCol]);
    if (colors && colMap.rgbCol >= 0) {
      const packed = parsePackedRgb(parts[colMap.rgbCol], plan.rgbField!);
      colors[writeIdx * 3] = ((packed >> 16) & 0xff) / 255;
      colors[writeIdx * 3 + 1] = ((packed >> 8) & 0xff) / 255;
      colors[writeIdx * 3 + 2] = (packed & 0xff) / 255;
    }
    writeIdx++;
    pointsRead++;
  }
  if (pointsRead !== header.pointCount) {
    throw new Error(`PCD ascii: expected ${header.pointCount} points, got ${pointsRead}`);
  }
  return { positions, colors };
}

function buildAsciiColumnMap(header: PcdHeader, plan: ChannelPlan) {
  let col = 0;
  let xCol = -1;
  let yCol = -1;
  let zCol = -1;
  let rgbCol = -1;
  for (const field of header.fields) {
    if (field === plan.xField) xCol = col;
    if (field === plan.yField) yCol = col;
    if (field === plan.zField) zCol = col;
    if (field === plan.rgbField) rgbCol = col;
    col += field.count;
  }
  return { xCol, yCol, zCol, rgbCol };
}

function decodeBinary(buffer: Uint8Array, header: PcdHeader): { positions: Float32Array; colors?: Float32Array } {
  const plan = planChannels(header);
  const view = new DataView(buffer.buffer, buffer.byteOffset + header.bodyOffset, header.pointCount * header.pointStride);
  const positions = new Float32Array(header.pointCount * 3);
  const colors = plan.rgbField ? new Float32Array(header.pointCount * 3) : undefined;
  for (let i = 0; i < header.pointCount; i++) {
    const base = i * header.pointStride;
    positions[i * 3] = readScalar(view, base + plan.xField!.offset, plan.xField!);
    positions[i * 3 + 1] = readScalar(view, base + plan.yField!.offset, plan.yField!);
    positions[i * 3 + 2] = readScalar(view, base + plan.zField!.offset, plan.zField!);
    if (colors && plan.rgbField) {
      const packed = view.getUint32(base + plan.rgbField.offset, true);
      colors[i * 3] = ((packed >> 16) & 0xff) / 255;
      colors[i * 3 + 1] = ((packed >> 8) & 0xff) / 255;
      colors[i * 3 + 2] = (packed & 0xff) / 255;
    }
  }
  return { positions, colors };
}

function decodeBinaryCompressed(buffer: Uint8Array, header: PcdHeader): { positions: Float32Array; colors?: Float32Array } {
  if (buffer.length < header.bodyOffset + 8) {
    throw new Error('PCD binary_compressed: truncated size header');
  }
  const sizeView = new DataView(buffer.buffer, buffer.byteOffset + header.bodyOffset, 8);
  const compressedSize = sizeView.getUint32(0, true);
  const uncompressedSize = sizeView.getUint32(4, true);
  const expectedUncompressed = header.pointCount * header.pointStride;
  if (uncompressedSize !== expectedUncompressed) {
    throw new Error(`PCD binary_compressed: declared uncompressed=${uncompressedSize} ` +
      `does not match fields*points=${expectedUncompressed}`);
  }
  const compressed = buffer.subarray(header.bodyOffset + 8, header.bodyOffset + 8 + compressedSize);
  const raw = decompressLZF(compressed, uncompressedSize);

  // SoA layout: contiguous block per field. Compute each field's start.
  const plan = planChannels(header);
  const fieldStart = new Map<PcdField, number>();
  let cursor = 0;
  for (const field of header.fields) {
    fieldStart.set(field, cursor);
    cursor += header.pointCount * field.size * field.count;
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const positions = new Float32Array(header.pointCount * 3);
  const colors = plan.rgbField ? new Float32Array(header.pointCount * 3) : undefined;
  const xBase = fieldStart.get(plan.xField!)!;
  const yBase = fieldStart.get(plan.yField!)!;
  const zBase = fieldStart.get(plan.zField!)!;
  const rgbBase = plan.rgbField ? fieldStart.get(plan.rgbField)! : 0;

  for (let i = 0; i < header.pointCount; i++) {
    positions[i * 3] = readScalar(view, xBase + i * plan.xField!.size, plan.xField!);
    positions[i * 3 + 1] = readScalar(view, yBase + i * plan.yField!.size, plan.yField!);
    positions[i * 3 + 2] = readScalar(view, zBase + i * plan.zField!.size, plan.zField!);
    if (colors && plan.rgbField) {
      const packed = view.getUint32(rgbBase + i * plan.rgbField.size, true);
      colors[i * 3] = ((packed >> 16) & 0xff) / 255;
      colors[i * 3 + 1] = ((packed >> 8) & 0xff) / 255;
      colors[i * 3 + 2] = (packed & 0xff) / 255;
    }
  }
  return { positions, colors };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function readScalar(view: DataView, offset: number, field: PcdField): number {
  if (field.type === 'F') {
    return field.size === 8 ? view.getFloat64(offset, true) : view.getFloat32(offset, true);
  }
  if (field.type === 'U') {
    if (field.size === 1) return view.getUint8(offset);
    if (field.size === 2) return view.getUint16(offset, true);
    if (field.size === 4) return view.getUint32(offset, true);
  } else {
    if (field.size === 1) return view.getInt8(offset);
    if (field.size === 2) return view.getInt16(offset, true);
    if (field.size === 4) return view.getInt32(offset, true);
  }
  throw new Error(`PCD: unsupported field width ${field.size} for type ${field.type}`);
}

const PARSE_BUFFER = new ArrayBuffer(4);
const PARSE_F32 = new Float32Array(PARSE_BUFFER);
const PARSE_U32 = new Uint32Array(PARSE_BUFFER);

function parsePackedRgb(token: string, field: PcdField): number {
  // PCL stores RGB as a uint32 (0x00RRGGBB) bit-reinterpreted to float and
  // emitted via printf("%g"). We have to round-trip the float bits back to
  // an integer to recover the channel bytes.
  if (field.type === 'F') {
    PARSE_F32[0] = Number(token);
    return PARSE_U32[0];
  }
  return Number(token) >>> 0;
}

function computeBBox(positions: Float32Array): PointCloudBBox {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
