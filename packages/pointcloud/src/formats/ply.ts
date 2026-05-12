/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PLY (Stanford Polygon) reader — point clouds only.
 *
 * Supports `format ascii 1.0`, `format binary_little_endian 1.0`, and
 * `format binary_big_endian 1.0`. Reads the `vertex` element exclusively;
 * `face` and other elements are skipped (they're meaningful for surface
 * meshes but not for the scan-style files this viewer ingests).
 *
 * Position fields (x/y/z) are required. RGB (r/g/b or red/green/blue,
 * uchar) and intensity (intensity, uchar/ushort/float) are optional and
 * surfaced when present. Returns a single `DecodedPointChunk` — large
 * .ply files (>25M points) get bounded by `streamPointCloud`'s memory
 * cap which downsamples upstream.
 */

import type { DecodedPointChunk, PointCloudBBox } from '../types.js';

/** Name → byte size for the PLY-defined scalar types. */
const TYPE_SIZES: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
};

interface PropertyDecl {
  name: string;
  type: string;
  size: number;
  /** Byte offset within a single vertex record (binary mode only). */
  offset: number;
}

interface ElementDecl {
  name: string;
  count: number;
  properties: PropertyDecl[];
  /** Bytes per record (binary mode); unused for ascii. */
  recordSize: number;
}

export interface PlyHeader {
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian';
  version: string;
  elements: ElementDecl[];
  /** Byte offset where the body data starts. */
  bodyOffset: number;
}

const TEXT_DECODER = new TextDecoder();

export function parsePlyHeader(buffer: Uint8Array): PlyHeader {
  // The header is ASCII. Find the line that says `end_header`. PLY files
  // never have headers larger than a few KB even with many properties;
  // 64 KB is a generous probe.
  const probeLen = Math.min(65536, buffer.length);
  const probe = TEXT_DECODER.decode(buffer.subarray(0, probeLen));
  if (!probe.startsWith('ply')) {
    throw new Error('PLY: missing magic — file does not start with "ply"');
  }
  const endIdx = probe.indexOf('end_header');
  if (endIdx < 0) {
    throw new Error('PLY: missing end_header line in first ' + probeLen + ' bytes');
  }
  // Body starts after the next newline that follows end_header.
  const newline = probe.indexOf('\n', endIdx);
  if (newline < 0) {
    throw new Error('PLY: end_header line not terminated by newline');
  }
  const headerText = probe.slice(0, newline + 1);
  const bodyOffset = newline + 1;

  const lines = headerText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  let format: PlyHeader['format'] | null = null;
  let version = '1.0';
  const elements: ElementDecl[] = [];
  let current: ElementDecl | null = null;

  for (const line of lines) {
    if (line === 'ply' || line === 'end_header') continue;
    if (line.startsWith('comment')) continue;
    if (line.startsWith('obj_info')) continue;
    if (line.startsWith('format ')) {
      const parts = line.split(/\s+/);
      const f = parts[1];
      version = parts[2] ?? '1.0';
      if (f === 'ascii' || f === 'binary_little_endian' || f === 'binary_big_endian') {
        format = f;
      } else {
        throw new Error(`PLY: unsupported format "${f}"`);
      }
      continue;
    }
    if (line.startsWith('element ')) {
      const parts = line.split(/\s+/);
      current = {
        name: parts[1],
        count: parseInt(parts[2], 10),
        properties: [],
        recordSize: 0,
      };
      elements.push(current);
      continue;
    }
    if (line.startsWith('property ')) {
      if (!current) {
        throw new Error(`PLY: property declared before any element: "${line}"`);
      }
      const parts = line.split(/\s+/);
      // Skip list properties (face indices etc.) — we don't render meshes.
      if (parts[1] === 'list') continue;
      const type = parts[1];
      const name = parts[2];
      const size = TYPE_SIZES[type];
      if (size === undefined) {
        throw new Error(`PLY: unknown property type "${type}"`);
      }
      current.properties.push({ name, type, size, offset: current.recordSize });
      current.recordSize += size;
      continue;
    }
  }

  if (!format) throw new Error('PLY: missing `format` line in header');
  if (!elements.some((e) => e.name === 'vertex')) {
    throw new Error('PLY: missing `vertex` element');
  }
  return { format, version, elements, bodyOffset };
}

export function decodePly(buffer: Uint8Array): DecodedPointChunk {
  const header = parsePlyHeader(buffer);
  const vertex = header.elements.find((e) => e.name === 'vertex');
  if (!vertex) throw new Error('PLY: no vertex element');
  // Both decoders start at header.bodyOffset, so vertex MUST be the first
  // element. Files that declare another element first would silently
  // produce garbage point data otherwise. Reject deterministically.
  if (header.elements[0] !== vertex) {
    throw new Error(
      `PLY: vertex element must appear first; saw "${header.elements[0]?.name}" first`,
    );
  }

  const xProp = vertex.properties.find((p) => p.name === 'x');
  const yProp = vertex.properties.find((p) => p.name === 'y');
  const zProp = vertex.properties.find((p) => p.name === 'z');
  if (!xProp || !yProp || !zProp) {
    throw new Error('PLY: vertex element must define x, y, z properties');
  }
  const rProp = vertex.properties.find((p) => p.name === 'red' || p.name === 'r');
  const gProp = vertex.properties.find((p) => p.name === 'green' || p.name === 'g');
  const bProp = vertex.properties.find((p) => p.name === 'blue' || p.name === 'b');
  const hasRgb = !!(rProp && gProp && bProp);
  const intensityProp = vertex.properties.find(
    (p) => p.name === 'intensity' || p.name === 'scalar_Intensity',
  );

  const count = vertex.count;
  const positions = new Float32Array(count * 3);
  const colors = hasRgb ? new Float32Array(count * 3) : undefined;
  const intensities = intensityProp ? new Uint16Array(count) : undefined;

  if (header.format === 'ascii') {
    decodeAsciiBody(buffer, header, vertex, positions, colors, intensities);
  } else {
    decodeBinaryBody(
      buffer,
      header,
      vertex,
      positions,
      colors,
      intensities,
      header.format === 'binary_little_endian',
    );
  }

  return {
    positions,
    colors,
    intensities,
    pointCount: count,
    bbox: computeBBox(positions),
  };
}

// ─── ascii body ─────────────────────────────────────────────────────────────

function decodeAsciiBody(
  buffer: Uint8Array,
  header: PlyHeader,
  vertex: ElementDecl,
  positions: Float32Array,
  colors: Float32Array | undefined,
  intensities: Uint16Array | undefined,
): void {
  // Decode just the vertex part of the body (other elements come after).
  // For ascii, each line = one vertex (in the order properties were
  // declared).
  const text = TEXT_DECODER.decode(buffer.subarray(header.bodyOffset));
  const xCol = vertex.properties.findIndex((p) => p.name === 'x');
  const yCol = vertex.properties.findIndex((p) => p.name === 'y');
  const zCol = vertex.properties.findIndex((p) => p.name === 'z');
  const rCol = vertex.properties.findIndex((p) => p.name === 'red' || p.name === 'r');
  const gCol = vertex.properties.findIndex((p) => p.name === 'green' || p.name === 'g');
  const bCol = vertex.properties.findIndex((p) => p.name === 'blue' || p.name === 'b');
  const iCol = vertex.properties.findIndex(
    (p) => p.name === 'intensity' || p.name === 'scalar_Intensity',
  );

  let lineStart = 0;
  let written = 0;
  while (written < vertex.count && lineStart < text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd).trim();
    lineStart = lineEnd + 1;
    if (!line) continue;
    const parts = line.split(/\s+/);
    positions[written * 3] = Number(parts[xCol]);
    positions[written * 3 + 1] = Number(parts[yCol]);
    positions[written * 3 + 2] = Number(parts[zCol]);
    if (colors && rCol >= 0 && gCol >= 0 && bCol >= 0) {
      colors[written * 3] = clamp01(Number(parts[rCol]) / 255);
      colors[written * 3 + 1] = clamp01(Number(parts[gCol]) / 255);
      colors[written * 3 + 2] = clamp01(Number(parts[bCol]) / 255);
    }
    if (intensities && iCol >= 0) {
      intensities[written] = Math.min(65535, Math.max(0, Number(parts[iCol]) | 0));
    }
    written++;
  }
  if (written !== vertex.count) {
    throw new Error(`PLY ascii: expected ${vertex.count} vertex lines, got ${written}`);
  }
}

// ─── binary body ────────────────────────────────────────────────────────────

function decodeBinaryBody(
  buffer: Uint8Array,
  header: PlyHeader,
  vertex: ElementDecl,
  positions: Float32Array,
  colors: Float32Array | undefined,
  intensities: Uint16Array | undefined,
  littleEndian: boolean,
): void {
  const stride = vertex.recordSize;
  const need = vertex.count * stride;
  if (buffer.length < header.bodyOffset + need) {
    throw new Error(`PLY binary: expected ${need} body bytes, got ${buffer.length - header.bodyOffset}`);
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset + header.bodyOffset, need);
  const xProp = vertex.properties.find((p) => p.name === 'x')!;
  const yProp = vertex.properties.find((p) => p.name === 'y')!;
  const zProp = vertex.properties.find((p) => p.name === 'z')!;
  const rProp = colors ? vertex.properties.find((p) => p.name === 'red' || p.name === 'r') : undefined;
  const gProp = colors ? vertex.properties.find((p) => p.name === 'green' || p.name === 'g') : undefined;
  const bProp = colors ? vertex.properties.find((p) => p.name === 'blue' || p.name === 'b') : undefined;
  const iProp = intensities
    ? vertex.properties.find((p) => p.name === 'intensity' || p.name === 'scalar_Intensity')
    : undefined;

  for (let i = 0; i < vertex.count; i++) {
    const base = i * stride;
    positions[i * 3] = readScalar(view, base + xProp.offset, xProp, littleEndian);
    positions[i * 3 + 1] = readScalar(view, base + yProp.offset, yProp, littleEndian);
    positions[i * 3 + 2] = readScalar(view, base + zProp.offset, zProp, littleEndian);
    if (colors && rProp && gProp && bProp) {
      colors[i * 3] = clamp01(readScalar(view, base + rProp.offset, rProp, littleEndian) / 255);
      colors[i * 3 + 1] = clamp01(readScalar(view, base + gProp.offset, gProp, littleEndian) / 255);
      colors[i * 3 + 2] = clamp01(readScalar(view, base + bProp.offset, bProp, littleEndian) / 255);
    }
    if (intensities && iProp) {
      intensities[i] = Math.min(65535, Math.max(0, readScalar(view, base + iProp.offset, iProp, littleEndian) | 0));
    }
  }
}

function readScalar(view: DataView, offset: number, prop: PropertyDecl, le: boolean): number {
  switch (prop.type) {
    case 'char':
    case 'int8':   return view.getInt8(offset);
    case 'uchar':
    case 'uint8':  return view.getUint8(offset);
    case 'short':
    case 'int16':  return view.getInt16(offset, le);
    case 'ushort':
    case 'uint16': return view.getUint16(offset, le);
    case 'int':
    case 'int32':  return view.getInt32(offset, le);
    case 'uint':
    case 'uint32': return view.getUint32(offset, le);
    case 'float':
    case 'float32': return view.getFloat32(offset, le);
    case 'double':
    case 'float64': return view.getFloat64(offset, le);
    default: throw new Error(`PLY: cannot read scalar of type "${prop.type}"`);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
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
