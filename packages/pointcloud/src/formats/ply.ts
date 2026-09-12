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
 * uchar), complete source normals (nx/ny/nz) and intensity
 * (intensity, uchar/ushort/float) are optional and surfaced when present.
 * `decodePly` is the direct whole-buffer API. The canonical Open/Add path
 * uses `PlyStreamingSource`, whose bounded decoder never allocates full-count
 * channels before applying its host-selected stride.
 */

import type { DecodedPointChunk, PointCloudBBox, PointNormalState } from '../types.js';
import { normalizePlyColors } from './ply-color.js';
import { parseAsciiVariableRow, parseBinaryVariableRow, writeVariablePlyRow } from './ply-variable-row.js';
import { decodeFixedBinaryPlyBody } from './ply-fixed-binary.js';

/** Name → byte size for the PLY-defined scalar types. */
const TYPE_SIZES: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
};

export interface PlyPropertyDecl {
  name: string;
  type: string;
  size: number;
  /** Byte offset within a single vertex record (binary mode only). */
  offset: number;
}

export interface PlyListPropertyDecl {
  kind: 'list'; name: string; countType: string; itemType: string;
  countSize: number; itemSize: number;
}

export type PlyPropertyOrderEntry = { kind: 'scalar'; property: PlyPropertyDecl } | PlyListPropertyDecl;

export interface PlyElementDecl {
  name: string;
  count: number;
  properties: PlyPropertyDecl[];
  propertyOrder: PlyPropertyOrderEntry[];
  /** Bytes per record (binary mode); unused for ascii. */
  recordSize: number;
  /**
   * The element declares at least one `property list`. Lists are variable
   * length, so `recordSize`/`properties` no longer describe the full record —
   * fine for skipped elements (faces), fatal for the vertex element the
   * decoders walk with a fixed stride.
   */
  hasListProperty: boolean;
  listPropertyNames: string[];
}

export interface PlyHeader {
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian';
  version: string;
  elements: PlyElementDecl[];
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
  const elements: PlyElementDecl[] = [];
  let current: PlyElementDecl | null = null;

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
      // Strict integer parse: `parseInt` would silently truncate "1.5" or
      // "12abc" — a count is a contract the decoders allocate against.
      if (!/^\d+$/.test(parts[2] ?? '')) {
        throw new Error(`PLY: invalid element count "${parts[2]}" for element "${parts[1]}"`);
      }
      current = {
        name: parts[1],
        count: parseInt(parts[2], 10),
        properties: [],
        propertyOrder: [],
        recordSize: 0,
        hasListProperty: false,
        listPropertyNames: [],
      };
      elements.push(current);
      continue;
    }
    if (line.startsWith('property ')) {
      if (!current) {
        throw new Error(`PLY: property declared before any element: "${line}"`);
      }
      const parts = line.split(/\s+/);
      // List properties (face indices etc.) are variable length; record the
      // fact and skip them — harmless on elements we never decode, rejected
      // for the vertex element in decodePly.
      if (parts[1] === 'list') {
        const countType = parts[2], itemType = parts[3], name = parts[4];
        const countSize = TYPE_SIZES[countType], itemSize = TYPE_SIZES[itemType];
        if (!name || countSize === undefined || itemSize === undefined) throw new Error(`PLY: invalid list property declaration "${line}"`);
        current.hasListProperty = true;
        current.listPropertyNames.push(name);
        current.propertyOrder.push({ kind: 'list', name, countType, itemType, countSize, itemSize });
        continue;
      }
      const type = parts[1];
      const name = parts[2];
      const size = TYPE_SIZES[type];
      if (size === undefined) {
        throw new Error(`PLY: unknown property type "${type}"`);
      }
      const property = { name, type, size, offset: current.recordSize };
      current.properties.push(property);
      current.propertyOrder.push({ kind: 'scalar', property });
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

export interface PlyVertexLayout {
  vertex: PlyElementDecl;
  xProp: PlyPropertyDecl; yProp: PlyPropertyDecl; zProp: PlyPropertyDecl;
  nxProp?: PlyPropertyDecl; nyProp?: PlyPropertyDecl; nzProp?: PlyPropertyDecl;
  normalState: PointNormalState;
}

/** Validate the fixed-row vertex schema shared by whole-file and streaming decode. */
export function inspectPlyVertex(header: PlyHeader): PlyVertexLayout {
  const vertex = header.elements.find((element) => element.name === 'vertex');
  if (!vertex) throw new Error('PLY: no vertex element');
  if (header.elements[0] !== vertex) {
    throw new Error(`PLY: vertex element must appear first; saw "${header.elements[0]?.name}" first`);
  }
  const normalNames = new Set(['nx', 'ny', 'nz']);
  const one = (name: string): PlyPropertyDecl | undefined => {
    const matches = vertex.properties.filter((property) => property.name === name);
    if (matches.length > 1) throw new Error(`PLY: vertex property "${name}" must not be declared more than once`);
    return matches[0];
  };
  const xProp = one('x'), yProp = one('y'), zProp = one('z');
  if (!xProp || !yProp || !zProp) throw new Error('PLY: vertex element must define x, y, z properties');
  const normalProps = (name: string) => vertex.properties.filter((property) => property.name === name);
  const nx = normalProps('nx'), ny = normalProps('ny'), nz = normalProps('nz');
  const declared = nx.length + ny.length + nz.length + vertex.listPropertyNames.filter((name) => normalNames.has(name)).length;
  const complete = declared === 3 && nx.length === 1 && ny.length === 1 && nz.length === 1;
  return { vertex, xProp, yProp, zProp, nxProp: complete ? nx[0] : undefined,
    nyProp: complete ? ny[0] : undefined, nzProp: complete ? nz[0] : undefined,
    normalState: declared === 0 ? 'absent' : complete ? 'supplied' : 'invalid' };
}

export function decodePly(
  buffer: Uint8Array,
  /**
   * Native (X, Y, Z)-axis offset subtracted from each decoded vertex in
   * f64, BEFORE narrowing to the `Float32Array` (extends #1804's LAS/LAZ
   * pattern — see `decodeLasPoints`'s `originOffset` doc). `undefined`
   * (the default) subtracts nothing, preserving prior behaviour
   * byte-for-byte.
   */
  originOffset?: readonly [number, number, number],
): DecodedPointChunk {
  const header = parsePlyHeader(buffer);
  const layout = inspectPlyVertex(header);
  const { vertex } = layout;
  const rProp = vertex.properties.find((p) => p.name === 'red' || p.name === 'r');
  const gProp = vertex.properties.find((p) => p.name === 'green' || p.name === 'g');
  const bProp = vertex.properties.find((p) => p.name === 'blue' || p.name === 'b');
  const hasRgb = !!(rProp && gProp && bProp);
  const { nxProp, nyProp, nzProp } = layout;
  const intensityProp = vertex.properties.find(
    (p) => p.name === 'intensity' || p.name === 'scalar_Intensity',
  );

  const count = vertex.count;
  if (!Number.isFinite(count) || count < 0) {
    throw new Error(`PLY: invalid vertex count ${count}`);
  }
  // Guard against a header that declares a huge vertex count backed by a tiny
  // body. Allocating `count*3` floats BEFORE reading would let a small hostile
  // file trigger a multi-GB allocation (OOM). Each record needs at least
  // `minBytesPerRecord` body bytes — exact for binary (recordSize), a
  // conservative floor for ascii (≥1 digit + 1 delimiter per column) — so
  // reject any count the remaining body cannot possibly back.
  const availableBytes = buffer.length - header.bodyOffset;
  const minBytesPerRecord =
    header.format === 'ascii'
      ? Math.max(1, vertex.properties.length * 2)
      : vertex.recordSize;
  // ascii: the LAST record needs no trailing separator (EOF terminates it),
  // so the floor is one byte less than count * minBytesPerRecord.
  const minBodyBytes =
    header.format === 'ascii' && count > 0
      ? count * minBytesPerRecord - 1
      : count * minBytesPerRecord;
  if (minBytesPerRecord > 0 && minBodyBytes > availableBytes) {
    throw new Error(
      `PLY: declared ${count} vertices need at least ${minBodyBytes} body bytes ` +
        `but only ${availableBytes} are available`,
    );
  }
  const positions = new Float32Array(count * 3);
  const colors = hasRgb ? new Float32Array(count * 3) : undefined;
  const normals = nxProp && nyProp && nzProp ? new Float32Array(count * 3) : undefined;
  const intensities = intensityProp ? new Uint16Array(count) : undefined;

  if (header.format === 'ascii') {
    if (vertex.hasListProperty) {
      const lines = TEXT_DECODER.decode(buffer.subarray(header.bodyOffset)).split(/\r?\n/).filter(line => line.trim());
      if (lines.length < count) throw new Error(`PLY ascii: expected ${count} vertex lines, got ${lines.length}`);
      for (let row = 0; row < count; row++) writeVariablePlyRow(parseAsciiVariableRow(lines[row].trim().split(/\s+/), vertex.propertyOrder, row), row,
        { positions, colors, normals, intensities, originOffset });
    } else decodeAsciiBody(buffer, header, vertex, positions, colors, normals, intensities, originOffset);
  } else {
    const littleEndian = header.format === 'binary_little_endian';
    if (vertex.hasListProperty) {
      const view = new DataView(buffer.buffer, buffer.byteOffset + header.bodyOffset, buffer.length - header.bodyOffset);
      let cursor = 0;
      for (let row = 0; row < count; row++) {
        const parsed = parseBinaryVariableRow(view, cursor, vertex.propertyOrder, littleEndian, row);
        writeVariablePlyRow(parsed.values, row, { positions, colors, normals, intensities, originOffset });
        cursor = parsed.end;
      }
    } else {
      const view = new DataView(buffer.buffer, buffer.byteOffset + header.bodyOffset, count * vertex.recordSize);
      decodeFixedBinaryPlyBody(view, vertex, positions, colors, normals, intensities, littleEndian, originOffset);
    }
  }

  if (colors && rProp && gProp && bProp) {
    normalizePlyColors(colors, [rProp.type, gProp.type, bProp.type]);
  }

  return {
    positions,
    colors,
    normals,
    normalState: normals && normals.every(Number.isFinite) && everyNormalNonzero(normals) ? 'supplied' : layout.normalState === 'supplied' ? 'invalid' : layout.normalState,
    intensities,
    pointCount: count,
    bbox: computeBBox(positions),
  };
}

function everyNormalNonzero(normals: Float32Array): boolean {
  for (let i = 0; i < normals.length; i += 3) if (normals[i] ** 2 + normals[i + 1] ** 2 + normals[i + 2] ** 2 === 0) return false;
  return true;
}

function decodeAsciiBody(
  buffer: Uint8Array,
  header: PlyHeader,
  vertex: PlyElementDecl,
  positions: Float32Array,
  colors: Float32Array | undefined,
  normals: Float32Array | undefined,
  intensities: Uint16Array | undefined,
  originOffset?: readonly [number, number, number],
): void {
  // Decode just the vertex part of the body (other elements come after).
  // For ascii, each line = one vertex (in the order properties were
  // declared).
  const text = TEXT_DECODER.decode(buffer.subarray(header.bodyOffset));
  const offX = originOffset?.[0] ?? 0;
  const offY = originOffset?.[1] ?? 0;
  const offZ = originOffset?.[2] ?? 0;
  const xCol = vertex.properties.findIndex((p) => p.name === 'x');
  const yCol = vertex.properties.findIndex((p) => p.name === 'y');
  const zCol = vertex.properties.findIndex((p) => p.name === 'z');
  const rCol = vertex.properties.findIndex((p) => p.name === 'red' || p.name === 'r');
  const gCol = vertex.properties.findIndex((p) => p.name === 'green' || p.name === 'g');
  const bCol = vertex.properties.findIndex((p) => p.name === 'blue' || p.name === 'b');
  const nxCol = vertex.properties.findIndex((p) => p.name === 'nx');
  const nyCol = vertex.properties.findIndex((p) => p.name === 'ny');
  const nzCol = vertex.properties.findIndex((p) => p.name === 'nz');
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
    positions[written * 3] = Number(parts[xCol]) - offX;
    positions[written * 3 + 1] = Number(parts[yCol]) - offY;
    positions[written * 3 + 2] = Number(parts[zCol]) - offZ;
    if (colors && rCol >= 0 && gCol >= 0 && bCol >= 0) {
      colors[written * 3] = Number(parts[rCol]);
      colors[written * 3 + 1] = Number(parts[gCol]);
      colors[written * 3 + 2] = Number(parts[bCol]);
    }
    if (normals) {
      normals[written * 3] = Number(parts[nxCol]);
      normals[written * 3 + 1] = Number(parts[nyCol]);
      normals[written * 3 + 2] = Number(parts[nzCol]);
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
