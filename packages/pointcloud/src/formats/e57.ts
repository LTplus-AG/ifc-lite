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

/**
 * Read a CompressedVector binary-section header (E57 spec §6.4.2) and
 * return the LOGICAL byte offset where its DataPackets actually start.
 *
 * Layout (32 bytes):
 *   [ 0]  u8     sectionId           (must == 1 for CompressedVector)
 *   [ 1]  u8[7]  reserved
 *   [ 8]  u64 LE sectionLogicalLength
 *   [16]  u64 LE dataPhysicalOffset
 *   [24]  u64 LE indexPhysicalOffset
 *
 * The XML's `points@fileOffset` points at this section header — NOT at
 * the first DataPacket. Reading packets straight at `fileOffset` puts
 * the parser ~32 bytes off and the first u16 it reads is the low half
 * of `sectionLogicalLength`, which usually decodes as a bytestreamCount
 * of 0 (matched the user-reported `bytestreamCount (0) ≠ prototype
 * length (7)` error exactly).
 */
export function resolveCompressedVectorDataOffset(
  logical: Uint8Array,
  physicalSectionOffset: number,
  pageSize: number,
): number {
  const sectionLogical = physicalToLogical(physicalSectionOffset, pageSize);
  if (sectionLogical + 32 > logical.length) {
    throw new Error(
      `E57: CompressedVector section header at logical ${sectionLogical} runs past end of file (length ${logical.length})`,
    );
  }
  const view = new DataView(logical.buffer, logical.byteOffset + sectionLogical, 32);
  const sectionId = view.getUint8(0);
  if (sectionId !== 1) {
    throw new Error(
      `E57: expected CompressedVector section (id=1) at physical ${physicalSectionOffset}, got id=${sectionId}`,
    );
  }
  const dataPhysicalOffset = readU64LE(view, 16);
  return physicalToLogical(dataPhysicalOffset, pageSize);
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
  /**
   * Whether this Data3D defines a `pose` element (translation +
   * rotation that places the scan in the file's global frame). We
   * don't apply the transform yet — single-scan files don't need it,
   * and multi-scan files with poses are rejected upfront so we never
   * silently merge in scan-local space.
   */
  hasPose?: boolean;
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
      hasPose: childByName(scan, 'pose') !== null,
    });
  }
  return entries;
}

// ─── binary decode ──────────────────────────────────────────────────────────

/**
 * Decode the binary section starting at `entry.binaryFileOffset` in the
 * logical-bytes view. NOTE: `binaryFileOffset` here must already point
 * at the first DataPacket (i.e. AFTER the 32-byte CompressedVector
 * section header) — `decodeE57` does this conversion via
 * `resolveCompressedVectorDataOffset`. Callers passing the raw XML
 * offset directly will see a "bytestreamCount ≠ prototype length"
 * mismatch.
 *
 * Returns one DecodedPointChunk per scan; caller can concatenate or
 * emit them as separate streaming chunks.
 *
 * Supports Float (single/double), ScaledInteger (bit-packed integer
 * with scale/offset), and Integer for cartesianX/Y/Z + colorRed/
 * Green/Blue + intensity. Other prototype fields are honoured for
 * stride math but discarded.
 */
export function decodeE57Scan(logical: Uint8Array, entry: Data3DEntry): DecodedPointChunk {
  const xField = findField(entry.prototype, 'cartesianX');
  const yField = findField(entry.prototype, 'cartesianY');
  const zField = findField(entry.prototype, 'cartesianZ');
  if (!xField || !yField || !zField) {
    throw new Error('E57: prototype missing cartesianX/Y/Z');
  }
  for (const f of [xField, yField, zField]) {
    if (f.kind === 'Integer') {
      // Plain integer cartesian coords don't appear in any real exporter
      // we've seen — the spec uses ScaledInteger when the cartesian is
      // integer-quantised. Fail clearly rather than silently producing
      // unscaled metres (or whatever the integer happens to be).
      throw new Error(
        `E57: cartesian${f.name.slice(-1)} encoded as plain Integer (only Float / ScaledInteger supported)`,
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
  const intensities = iField ? new Uint16Array(entry.recordCount) : undefined;

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

    // Decode this packet's points. Compute per-axis capacity since
    // Float (fixed byte size) and ScaledInteger (bit-packed) compute
    // differently; take the minimum.
    const xPos = fieldOffsets.get('cartesianX')!;
    const yPos = fieldOffsets.get('cartesianY')!;
    const zPos = fieldOffsets.get('cartesianZ')!;
    const xCapacity = floatOrSiPointCapacity(xField, xPos.length);
    const yCapacity = floatOrSiPointCapacity(yField, yPos.length);
    const zCapacity = floatOrSiPointCapacity(zField, zPos.length);
    const pointsInPacket = Math.min(xCapacity, yCapacity, zCapacity);
    const take = Math.min(pointsInPacket, entry.recordCount - written);

    readCartesianStream(logical, view, xField, xPos.start, positions, written, take, 0);
    readCartesianStream(logical, view, yField, yPos.start, positions, written, take, 1);
    readCartesianStream(logical, view, zField, zPos.start, positions, written, take, 2);

    if (colors && rField && gField && bField) {
      writeColorChannel(view, fieldOffsets.get('colorRed')!.start, rField, colors, written, take, 0, logical);
      writeColorChannel(view, fieldOffsets.get('colorGreen')!.start, gField, colors, written, take, 1, logical);
      writeColorChannel(view, fieldOffsets.get('colorBlue')!.start, bField, colors, written, take, 2, logical);
    }
    if (intensities && iField) {
      readIntensityStream(logical, view, iField, fieldOffsets.get('intensity')!.start, intensities, written, take);
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
  bytes: Uint8Array,
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
    // ScaledInteger colour: bit-packed integer with declared min/max.
    // The "scale + offset" attributes still apply per spec but for
    // colour they always normalise to the declared range, so we just
    // remap [minimum, maximum] → [0, 1] like Integer colour does.
    const min = field.minimum ?? 0;
    const max = field.maximum ?? 1;
    const span = max - min;
    const inv = span > 0 ? 1 / span : 1;
    const bitsPerRecord = scaledIntegerBitsPerRecord(field);
    const startBit = start * 8;
    for (let i = 0; i < take; i++) {
      const raw = readBitsLE(bytes, startBit + i * bitsPerRecord, bitsPerRecord);
      colors[(written + i) * 3 + channelOffset] = clamp01(raw * inv);
    }
  }
}

/**
 * Read N points from a cartesian (X / Y / Z) bytestream into the
 * positions array. Float: straight DataView reads; ScaledInteger:
 * bit-pack walk plus per-record `raw * scale + offset`.
 *
 * `axis` selects which of the three position slots to write to
 * (0 = X, 1 = Y, 2 = Z) so the caller doesn't have to interleave
 * three separate calls per axis.
 */
function readCartesianStream(
  bytes: Uint8Array,
  view: DataView,
  field: PrototypeField,
  start: number,
  positions: Float32Array,
  written: number,
  take: number,
  axis: 0 | 1 | 2,
): void {
  if (field.kind === 'Float') {
    const stride = field.precision === 'single' ? 4 : 8;
    if (stride === 4) {
      for (let i = 0; i < take; i++) {
        positions[(written + i) * 3 + axis] = view.getFloat32(start + i * stride, true);
      }
    } else {
      for (let i = 0; i < take; i++) {
        positions[(written + i) * 3 + axis] = view.getFloat64(start + i * stride, true);
      }
    }
    return;
  }
  // ScaledInteger: raw integer + scale/offset/minimum from prototype.
  // Per spec the encoded stream stores `raw_int = (value - minimum)`
  // (so it's an unsigned bit-pack), and the decoded float is
  // `raw_int * scale + offset + minimum * scale`. Equivalent to the
  // form below where we just add `minimum` back to the raw int and
  // multiply by `scale` once.
  const bitsPerRecord = scaledIntegerBitsPerRecord(field);
  const minimum = field.minimum ?? 0;
  const scale = field.scale ?? 1;
  const offset = field.offset ?? 0;
  const startBit = start * 8;
  for (let i = 0; i < take; i++) {
    const raw = readBitsLE(bytes, startBit + i * bitsPerRecord, bitsPerRecord);
    positions[(written + i) * 3 + axis] = (raw + minimum) * scale + offset;
  }
}

/**
 * Read N intensity samples from a bytestream and normalise to u16.
 * Handles Float (multiply by 65535), Integer (declared-range remap),
 * and ScaledInteger (bit-pack walk → declared-range remap).
 */
function readIntensityStream(
  bytes: Uint8Array,
  view: DataView,
  field: PrototypeField,
  start: number,
  intensities: Uint16Array,
  written: number,
  take: number,
): void {
  if (field.kind === 'Float') {
    const stride = field.precision === 'single' ? 4 : 8;
    for (let i = 0; i < take; i++) {
      const v = stride === 4 ? view.getFloat32(start + i * stride, true) : view.getFloat64(start + i * stride, true);
      intensities[written + i] = Math.min(65535, Math.max(0, Math.round(v * 65535)));
    }
    return;
  }
  if (field.kind === 'Integer') {
    const min = field.minimum ?? 0;
    const max = field.maximum ?? 65535;
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
      const norm = (raw - min) * inv;
      intensities[written + i] = Math.min(65535, Math.max(0, Math.round(norm * 65535)));
    }
    return;
  }
  // ScaledInteger intensity: same range-remap as Integer, but the raw
  // int comes from a bit-pack walk and `raw + minimum` recovers the
  // original sensor reading.
  const bitsPerRecord = scaledIntegerBitsPerRecord(field);
  const minimum = field.minimum ?? 0;
  const maximum = field.maximum ?? minimum;
  const span = maximum - minimum;
  const inv = span > 0 ? 1 / span : 1;
  const startBit = start * 8;
  for (let i = 0; i < take; i++) {
    const raw = readBitsLE(bytes, startBit + i * bitsPerRecord, bitsPerRecord);
    // Already-normalised value (raw maps 0..span). Remap to u16.
    intensities[written + i] = Math.min(65535, Math.max(0, Math.round(raw * inv * 65535)));
  }
}

/**
 * E57 spec §6.3.4: bitsPerRecord = ceil(log2(maximum - minimum + 1)).
 * Handles edge case `maximum === minimum` → 1 bit (constant value).
 * Caps at 53 bits — our Number-based bit reader can't go further
 * without BigInt, and no real exporter uses wider ScaledInteger
 * fields anyway (LiDAR + survey kit tops out around 32 bits).
 */
function scaledIntegerBitsPerRecord(field: PrototypeField): number {
  const min = field.minimum ?? 0;
  const max = field.maximum ?? min;
  const span = Math.max(0, max - min);
  if (span === 0) return 1;
  const bits = Math.ceil(Math.log2(span + 1));
  if (bits > 53) {
    throw new Error(
      `E57: ScaledInteger field "${field.name}" needs ${bits} bits — exceeds the 53-bit Number-precision limit`,
    );
  }
  return Math.max(1, bits);
}

/**
 * Compute how many points fit in `lengthBytes` for a given field.
 * Float fields: floor(length / byteSize). ScaledInteger / Integer:
 * floor(length * 8 / bitsPerRecord) — bits in the stream divided by
 * bits per record.
 */
function floatOrSiPointCapacity(field: PrototypeField, lengthBytes: number): number {
  if (field.kind === 'Float') {
    const byteSize = field.precision === 'single' ? 4 : 8;
    return Math.floor(lengthBytes / byteSize);
  }
  if (field.kind === 'ScaledInteger') {
    const bits = scaledIntegerBitsPerRecord(field);
    return Math.floor((lengthBytes * 8) / bits);
  }
  // Integer: pick the same width as writeColorChannel.
  const min = field.minimum ?? 0;
  const max = field.maximum ?? 255;
  const widest = Math.max(Math.abs(min), Math.abs(max));
  const byteSize = widest > 255 ? 2 : 1;
  return Math.floor(lengthBytes / byteSize);
}

/**
 * Read `bitsPerRecord` bits starting at `bitOffset` from `bytes`.
 * Bits within each byte are LSB-first (E57 spec convention).
 *
 * Uses `Math.pow(2, n)` instead of `<< n` so the result keeps
 * full Number precision up to 53 bits; `<<` would silently
 * truncate at 32.
 */
function readBitsLE(bytes: Uint8Array, bitOffset: number, bitsPerRecord: number): number {
  let value = 0;
  let bitsRead = 0;
  let cur = bitOffset >>> 3;
  let inByte = bitOffset & 7;
  while (bitsRead < bitsPerRecord) {
    const avail = 8 - inByte;
    const take = Math.min(avail, bitsPerRecord - bitsRead);
    const mask = (1 << take) - 1;
    const piece = (bytes[cur] >>> inByte) & mask;
    value += piece * Math.pow(2, bitsRead);
    bitsRead += take;
    inByte = 0;
    cur++;
  }
  return value;
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

  // Multi-scan registered E57 files store each scan in its own local
  // frame and rely on the per-Data3D `pose` (rotation + translation) to
  // place them in the file's global frame. We don't apply that
  // transform yet, so silently concatenating registered multi-scan
  // files would produce a misaligned mess. Reject upfront with a
  // clear error so the user can use the export-merged option in their
  // scan-processing tool.
  if (entries.length > 1 && entries.some((e) => e.hasPose)) {
    throw new Error(
      `E57: file contains ${entries.length} scans with per-scan poses (registered multi-scan). `
      + 'Multi-scan pose merging is not yet supported — please re-export as a single merged scan.',
    );
  }

  // Resolve every entry's binary file offset through the
  // CompressedVector section header. The XML's fileOffset is the
  // section header (physical), not the first DataPacket.
  const chunks = entries.map((entry) => {
    const dataLogicalOffset = resolveCompressedVectorDataOffset(
      logical,
      entry.binaryFileOffset,
      header.pageSize,
    );
    return decodeE57Scan(logical, { ...entry, binaryFileOffset: dataLogicalOffset });
  });
  if (chunks.length === 1) return chunks[0];

  // Concatenate. Use some() so a single scan that lacks color/intensity
  // doesn't drop the channel for the whole merged cloud — we just leave
  // its slice at the default zeros and emit the channel anyway.
  let total = 0;
  for (const c of chunks) total += c.pointCount;
  const positions = new Float32Array(total * 3);
  const hasColors = chunks.some((c) => c.colors);
  const hasIntensity = chunks.some((c) => c.intensities);
  const colors = hasColors ? new Float32Array(total * 3) : undefined;
  const intensities = hasIntensity ? new Uint16Array(total) : undefined;
  let off = 0;
  for (const c of chunks) {
    positions.set(c.positions, off * 3);
    // Per-chunk conditional set: chunks without a channel just leave
    // their slice at the default zero, which renders as black for
    // colors / unlit for intensity. Better than dropping the whole
    // channel because of a single mixed-attribute file.
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
