/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * E57 (ASTM E2807-11) reader — point cloud subset.
 *
 * Scope:
 *   - File header (48 bytes) — magic + xmlPhysicalOffset/Length + pageSize.
 *   - Physical → logical view: every 1024-byte page ends with a 4-byte
 *     CRC32-C; we strip those to get the logical byte stream the XML +
 *     binary indices reference. CRCs are NOT validated (faster + still
 *     correct for well-formed files).
 *   - XML parsed with DOMParser to find Data3D entries with FloatNodes
 *     for cartesianX / cartesianY / cartesianZ and optional colorRed /
 *     colorGreen / colorBlue / intensity.
 *   - Binary section: walk DataPackets at the prototype's CompressedVector
 *     fileOffset, decode bytestreams as raw Float32 / Float64 columns.
 *
 * What we don't yet support:
 *   - ScaledIntegerNode encoding (bit-packed integers with scale/offset)
 *     — this is the more compact format; we throw a clear error so the
 *     caller can guide the user to a Float-encoded export.
 *   - Spherical coordinates (most files use cartesian).
 *   - Per-scan pose transforms — points come back in scan-local space.
 *
 * That subset still covers a large fraction of real-world E57 files
 * (Faro, Leica, Trimble, generic exports) and gives a clean error
 * message on the rest.
 */

import type { DecodedPointChunk, PointCloudBBox } from '../types.js';
import {
  childByName,
  childrenByName,
  parseXml,
  textChild,
} from '../xml-mini.js';

const E57_MAGIC = 'ASTM-E57';

export interface E57FileHeader {
  majorVersion: number;
  minorVersion: number;
  fileLogicalSize: number;
  xmlLogicalOffset: number;
  xmlLogicalLength: number;
  pageSize: number;
}

/** Read the 48-byte FileHeader. Throws on bad magic. */
export function parseE57FileHeader(bytes: Uint8Array): E57FileHeader {
  if (bytes.length < 48) throw new Error('E57: header truncated (need 48 bytes)');
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== E57_MAGIC) {
    throw new Error(`E57: bad magic "${magic}" (expected "${E57_MAGIC}")`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    majorVersion: view.getUint32(8, true),
    minorVersion: view.getUint32(12, true),
    fileLogicalSize: readU64LE(view, 16),
    // Physical XML offset → we convert to logical below; xmlLogicalLength
    // is the byte length AFTER stripping page CRCs.
    xmlLogicalOffset: physicalToLogical(readU64LE(view, 24), readU64LE(view, 40)),
    xmlLogicalLength: readU64LE(view, 32),
    pageSize: readU64LE(view, 40),
  };
}

/**
 * Strip the 4-byte CRC tail from each `pageSize`-byte physical page.
 *
 * Returns a freshly-allocated buffer of "logical" bytes — the form that
 * XML offsets and CompressedVector data offsets reference.
 *
 * `pageSize` is read from the header and is conventionally 1024.
 */
export function stripPageCrc(bytes: Uint8Array, pageSize: number): Uint8Array {
  if (pageSize <= 4) throw new Error('E57: pageSize too small');
  const payloadPerPage = pageSize - 4;
  const fullPages = Math.floor(bytes.length / pageSize);
  const tail = bytes.length - fullPages * pageSize;
  // Trailing partial page (if any) still carries 4 CRC bytes when complete;
  // when the file ends mid-page we can't trust those tail bytes, so we
  // stop at the last complete page boundary.
  const out = new Uint8Array(fullPages * payloadPerPage + Math.max(0, tail - 4));
  let dst = 0;
  for (let p = 0; p < fullPages; p++) {
    const src = p * pageSize;
    out.set(bytes.subarray(src, src + payloadPerPage), dst);
    dst += payloadPerPage;
  }
  if (tail > 4) {
    const src = fullPages * pageSize;
    out.set(bytes.subarray(src, src + tail - 4), dst);
  }
  return out;
}

/** Convert a physical (CRC-paged) offset to the equivalent logical offset. */
function physicalToLogical(physical: number, pageSize: number): number {
  const payloadPerPage = pageSize - 4;
  const pages = Math.floor(physical / pageSize);
  const within = physical - pages * pageSize;
  return pages * payloadPerPage + within;
}

// ─── XML model ──────────────────────────────────────────────────────────────

interface PrototypeField {
  name: string;
  kind: 'Float' | 'ScaledInteger' | 'Integer';
  precision?: 'single' | 'double';
  scale?: number;
  offset?: number;
  minimum?: number;
  maximum?: number;
}

export interface Data3DEntry {
  guid: string;
  name?: string;
  recordCount: number;
  /** Logical offset into the file where the binary section begins. */
  binaryFileOffset: number;
  /** Field declarations in record order. */
  prototype: PrototypeField[];
}

const TEXT_DECODER = new TextDecoder();

/**
 * Parse the E57 XML section.
 *
 * Uses our own minimal SAX-style parser (`xml-mini.ts`) instead of
 * `DOMParser` because dedicated Web Workers — where the decode runs —
 * don't expose DOMParser. The shape we need (e57Root → data3D →
 * vectorChild → prototype) is shallow and attribute-heavy, well within
 * the mini parser's scope.
 */
export function parseE57Xml(xmlText: string): Data3DEntry[] {
  const root = parseXml(xmlText);
  if (root.name !== 'e57Root') {
    throw new Error(`E57: XML root is not <e57Root> (saw <${root.name || '?'}>)`);
  }
  const data3D = childByName(root, 'data3D');
  if (!data3D) return [];
  const entries: Data3DEntry[] = [];
  for (const scan of childrenByName(data3D, 'vectorChild')) {
    const points = childByName(scan, 'points');
    if (!points) continue;
    if (points.attrs.get('type') !== 'CompressedVector') {
      // Skip non-compressed-vector points (rare).
      continue;
    }
    const fileOffsetAttr = points.attrs.get('fileOffset');
    const recordCountAttr = points.attrs.get('recordCount');
    if (!fileOffsetAttr || !recordCountAttr) continue;
    const proto = childByName(points, 'prototype');
    if (!proto) continue;
    const fields: PrototypeField[] = [];
    for (const f of proto.children) {
      const type = f.attrs.get('type') ?? '';
      if (type === 'Float') {
        fields.push({
          name: f.name,
          kind: 'Float',
          precision: f.attrs.get('precision') === 'single' ? 'single' : 'double',
        });
      } else if (type === 'ScaledInteger') {
        fields.push({
          name: f.name,
          kind: 'ScaledInteger',
          scale: Number(f.attrs.get('scale') ?? '1'),
          offset: Number(f.attrs.get('offset') ?? '0'),
          minimum: Number(f.attrs.get('minimum') ?? '0'),
          maximum: Number(f.attrs.get('maximum') ?? '0'),
        });
      } else if (type === 'Integer') {
        fields.push({
          name: f.name,
          kind: 'Integer',
          minimum: Number(f.attrs.get('minimum') ?? '0'),
          maximum: Number(f.attrs.get('maximum') ?? '0'),
        });
      }
      // Other types (e.g. String) ignored — never carry point data.
    }
    entries.push({
      guid: textChild(scan, 'guid') ?? '',
      name: textChild(scan, 'name') ?? undefined,
      recordCount: Number(recordCountAttr),
      binaryFileOffset: Number(fileOffsetAttr),
      prototype: fields,
    });
  }
  return entries;
}

// ─── binary decode ──────────────────────────────────────────────────────────

/**
 * Decode the binary section starting at `entry.binaryFileOffset` in the
 * logical-bytes view. Returns one DecodedPointChunk per scan; caller can
 * concatenate or emit them as separate streaming chunks.
 *
 * Limitations (Phase-1 E57):
 *   - Only Float (single/double) prototype fields are decoded. Files
 *     using ScaledInteger throw a clear error so the host can fall back
 *     gracefully.
 *   - Reads only cartesianX/Y/Z + colorRed/Green/Blue + intensity when
 *     present. Other fields are honoured for stride math but discarded.
 */
export function decodeE57Scan(logical: Uint8Array, entry: Data3DEntry): DecodedPointChunk {
  const xField = findField(entry.prototype, 'cartesianX');
  const yField = findField(entry.prototype, 'cartesianY');
  const zField = findField(entry.prototype, 'cartesianZ');
  if (!xField || !yField || !zField) {
    throw new Error('E57: prototype missing cartesianX/Y/Z');
  }
  for (const f of [xField, yField, zField]) {
    if (f.kind !== 'Float') {
      throw new Error(
        `E57: cartesianX/Y/Z encoded as ${f.kind} (only Float supported in this build)`,
      );
    }
  }
  const rField = findField(entry.prototype, 'colorRed');
  const gField = findField(entry.prototype, 'colorGreen');
  const bField = findField(entry.prototype, 'colorBlue');
  const hasRgb = !!(rField && gField && bField);
  const iField = findField(entry.prototype, 'intensity');

  const positions = new Float32Array(entry.recordCount * 3);
  const colors = hasRgb ? new Float32Array(entry.recordCount * 3) : undefined;
  const intensities = iField && iField.kind === 'Float' ? new Uint16Array(entry.recordCount) : undefined;

  // Walk DataPackets starting at binaryFileOffset.
  // Packet header (4 bytes):
  //   byte 0: packetType (1=data, 2=index, 3=empty)
  //   byte 1: packetFlags (bit 0 = compressorRestart)
  //   bytes 2..3: packetLogicalLength - 1 (LE u16; total packet bytes minus 1)
  // Followed by per-bytestream sections, then 4-byte CRC at the end of
  // each packet (already part of the page-level CRC strip — packet CRCs
  // sit in the LOGICAL stream and we ignore them here for speed).
  let offset = entry.binaryFileOffset;
  const view = new DataView(logical.buffer, logical.byteOffset, logical.byteLength);
  let written = 0;

  while (written < entry.recordCount && offset < logical.length) {
    if (offset + 4 > logical.length) {
      throw new Error('E57: truncated DataPacket header');
    }
    const packetType = view.getUint8(offset);
    // packetFlags = view.getUint8(offset + 1)  // unused for plain data
    const packetLogicalLength = view.getUint16(offset + 2, true) + 1;
    if (packetType !== 1) {
      // Skip non-data packets (index/empty); they may appear interleaved.
      offset += packetLogicalLength;
      continue;
    }
    const packetEnd = offset + packetLogicalLength;
    if (packetEnd > logical.length) {
      throw new Error('E57: DataPacket runs past end of logical bytes');
    }
    // Data packet header beyond the common 4 bytes:
    //   byte 4..5: bytestreamCount (u16 LE)
    //   then `bytestreamCount` × u16 LE = bytestreamByteCount[]
    //   then payload (concatenated bytestreams, in prototype order)
    const bytestreamCount = view.getUint16(offset + 4, true);
    if (bytestreamCount !== entry.prototype.length) {
      throw new Error(
        `E57: packet bytestreamCount (${bytestreamCount}) ≠ prototype length (${entry.prototype.length})`,
      );
    }
    const bytestreamLengths: number[] = [];
    let cursor = offset + 6;
    for (let i = 0; i < bytestreamCount; i++) {
      bytestreamLengths.push(view.getUint16(cursor, true));
      cursor += 2;
    }
    // CRC at packet tail (4 bytes) — ignored.
    const packetPointsBefore = written;
    const fieldOffsets = new Map<string, { start: number; length: number }>();
    let streamCursor = cursor;
    for (let i = 0; i < bytestreamCount; i++) {
      fieldOffsets.set(entry.prototype[i].name, { start: streamCursor, length: bytestreamLengths[i] });
      streamCursor += bytestreamLengths[i];
    }

    // Decode this packet's points
    const xByteSize = xField.precision === 'single' ? 4 : 8;
    const yByteSize = yField.precision === 'single' ? 4 : 8;
    const zByteSize = zField.precision === 'single' ? 4 : 8;
    const pointsInPacket = Math.floor((fieldOffsets.get('cartesianX')!.length) / xByteSize);
    if (
      pointsInPacket !== Math.floor(fieldOffsets.get('cartesianY')!.length / yByteSize)
      || pointsInPacket !== Math.floor(fieldOffsets.get('cartesianZ')!.length / zByteSize)
    ) {
      throw new Error('E57: cartesianX/Y/Z bytestream lengths disagree on point count');
    }
    const take = Math.min(pointsInPacket, entry.recordCount - written);

    const xStart = fieldOffsets.get('cartesianX')!.start;
    const yStart = fieldOffsets.get('cartesianY')!.start;
    const zStart = fieldOffsets.get('cartesianZ')!.start;

    if (xField.precision === 'single') {
      for (let i = 0; i < take; i++) {
        positions[(written + i) * 3] = view.getFloat32(xStart + i * 4, true);
      }
    } else {
      for (let i = 0; i < take; i++) {
        positions[(written + i) * 3] = view.getFloat64(xStart + i * 8, true);
      }
    }
    if (yField.precision === 'single') {
      for (let i = 0; i < take; i++) {
        positions[(written + i) * 3 + 1] = view.getFloat32(yStart + i * 4, true);
      }
    } else {
      for (let i = 0; i < take; i++) {
        positions[(written + i) * 3 + 1] = view.getFloat64(yStart + i * 8, true);
      }
    }
    if (zField.precision === 'single') {
      for (let i = 0; i < take; i++) {
        positions[(written + i) * 3 + 2] = view.getFloat32(zStart + i * 4, true);
      }
    } else {
      for (let i = 0; i < take; i++) {
        positions[(written + i) * 3 + 2] = view.getFloat64(zStart + i * 8, true);
      }
    }

    if (colors && rField && gField && bField) {
      writeColorChannel(view, fieldOffsets.get('colorRed')!.start, rField, colors, written, take, 0);
      writeColorChannel(view, fieldOffsets.get('colorGreen')!.start, gField, colors, written, take, 1);
      writeColorChannel(view, fieldOffsets.get('colorBlue')!.start, bField, colors, written, take, 2);
    }
    if (intensities && iField) {
      const iStart = fieldOffsets.get('intensity')!.start;
      const stride = iField.precision === 'single' ? 4 : 8;
      for (let i = 0; i < take; i++) {
        const v = stride === 4 ? view.getFloat32(iStart + i * stride, true) : view.getFloat64(iStart + i * stride, true);
        intensities[written + i] = Math.min(65535, Math.max(0, Math.round(v * 65535)));
      }
    }

    written += take;
    void packetPointsBefore;
    offset = packetEnd;
  }

  if (written < entry.recordCount) {
    // Real-world files sometimes report counts a few records higher
    // than what's actually stored; trim positions to the actual count
    // so downstream code doesn't see uninitialised tail values.
    return finalize(positions.subarray(0, written * 3), colors?.subarray(0, written * 3), intensities?.subarray(0, written), written);
  }
  return finalize(positions, colors, intensities, entry.recordCount);
}

function writeColorChannel(
  view: DataView,
  start: number,
  field: PrototypeField,
  colors: Float32Array,
  written: number,
  take: number,
  channelOffset: 0 | 1 | 2,
): void {
  if (field.kind === 'Float') {
    const stride = field.precision === 'single' ? 4 : 8;
    for (let i = 0; i < take; i++) {
      const v = stride === 4 ? view.getFloat32(start + i * stride, true) : view.getFloat64(start + i * stride, true);
      colors[(written + i) * 3 + channelOffset] = clamp01(v);
    }
  } else if (field.kind === 'Integer') {
    // Pick element width from the declared range. E57 producers use
    // either u8 (0..255 — most common) or u16 (0..65535). Both
    // appear in real files; assuming u8 distorts u16-encoded colors.
    const min = field.minimum ?? 0;
    const max = field.maximum ?? 255;
    const span = max - min;
    const inv = span > 0 ? 1 / span : 1;
    const widest = Math.max(Math.abs(min), Math.abs(max));
    const stride = widest > 255 ? 2 : 1;
    const signed = min < 0;
    for (let i = 0; i < take; i++) {
      const off = start + i * stride;
      const raw = stride === 2
        ? (signed ? view.getInt16(off, true) : view.getUint16(off, true))
        : (signed ? view.getInt8(off) : view.getUint8(off));
      colors[(written + i) * 3 + channelOffset] = clamp01((raw - min) * inv);
    }
  } else {
    throw new Error('E57: ScaledInteger color encoding not yet supported');
  }
}

function finalize(
  positions: Float32Array,
  colors: Float32Array | undefined,
  intensities: Uint16Array | undefined,
  pointCount: number,
): DecodedPointChunk {
  return {
    positions: new Float32Array(positions),
    colors: colors ? new Float32Array(colors) : undefined,
    intensities: intensities ? new Uint16Array(intensities) : undefined,
    pointCount,
    bbox: computeBBox(positions),
  };
}

function findField(proto: PrototypeField[], name: string): PrototypeField | undefined {
  return proto.find((p) => p.name === name);
}

function readU64LE(view: DataView, offset: number): number {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  return hi * 0x100000000 + lo;
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

// ─── high-level entry ───────────────────────────────────────────────────────

/**
 * Decode all Data3D scans in an E57 file. Combines them into a single
 * DecodedPointChunk (positions concatenated). Returns null when the
 * file has no scans.
 */
export function decodeE57(bytes: Uint8Array): DecodedPointChunk | null {
  const header = parseE57FileHeader(bytes);
  const logical = stripPageCrc(bytes, header.pageSize);
  const xmlBytes = logical.subarray(header.xmlLogicalOffset, header.xmlLogicalOffset + header.xmlLogicalLength);
  const xmlText = TEXT_DECODER.decode(xmlBytes);
  const entries = parseE57Xml(xmlText);
  if (entries.length === 0) return null;

  const chunks = entries.map((e) => decodeE57Scan(logical, e));
  if (chunks.length === 1) return chunks[0];

  // Concatenate
  let total = 0;
  for (const c of chunks) total += c.pointCount;
  const positions = new Float32Array(total * 3);
  const hasColors = chunks.every((c) => c.colors);
  const hasIntensity = chunks.every((c) => c.intensities);
  const colors = hasColors ? new Float32Array(total * 3) : undefined;
  const intensities = hasIntensity ? new Uint16Array(total) : undefined;
  let off = 0;
  for (const c of chunks) {
    positions.set(c.positions, off * 3);
    if (colors && c.colors) colors.set(c.colors, off * 3);
    if (intensities && c.intensities) intensities.set(c.intensities, off);
    off += c.pointCount;
  }
  return {
    positions,
    colors,
    intensities,
    pointCount: total,
    bbox: computeBBox(positions),
  };
}
