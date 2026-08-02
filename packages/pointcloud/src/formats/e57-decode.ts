/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * E57 binary-section decoder for a single Data3D scan.
 *
 * Walks DataPackets at `entry.binaryFileOffset` (in the LOGICAL
 * post-CRC view) and decodes per-record bytestreams as Float32 /
 * Float64 / Integer / ScaledInteger columns. ScaledInteger is a
 * bit-packed integer with a per-field scale + offset (E57 spec
 * §6.3.4) — common in Faro / Trimble / Leica exports.
 */

import type { DecodedPointChunk, PointCloudBBox } from '../types.js';
import { findField, type Data3DEntry, type PrototypeField } from './e57-xml.js';

/**
 * Resolved prototype field set for one scan: the cartesian axes (always
 * present, validated) plus the optional colour / intensity /
 * classification channels and the predicates that decide which output
 * buffers to allocate. Shared by the whole-file (`decodeE57Scan`) and
 * the streaming (`E57StreamingSource`) decoders so both agree on which
 * channels a scan carries.
 */
export interface ScanFieldSet {
  xField: PrototypeField;
  yField: PrototypeField;
  zField: PrototypeField;
  rField?: PrototypeField;
  gField?: PrototypeField;
  bField?: PrototypeField;
  /** colorRed/Green/Blue all present → emit a colours buffer. */
  hasRgb: boolean;
  iField?: PrototypeField;
  /** intensity present (any supported kind) → emit an intensities buffer. */
  hasIntensity: boolean;
  cField?: PrototypeField;
  /** classification present as Integer/ScaledInteger → emit a class buffer. */
  hasClassification: boolean;
}

/**
 * Validate + resolve a scan's prototype into a `ScanFieldSet`. Throws on
 * a missing or plain-Integer cartesian axis (only Float / ScaledInteger
 * cartesian is supported — see the inline note below).
 */
export function resolveScanFields(prototype: PrototypeField[]): ScanFieldSet {
  const xField = findField(prototype, 'cartesianX');
  const yField = findField(prototype, 'cartesianY');
  const zField = findField(prototype, 'cartesianZ');
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
  const rField = findField(prototype, 'colorRed');
  const gField = findField(prototype, 'colorGreen');
  const bField = findField(prototype, 'colorBlue');
  const hasRgb = !!(rField && gField && bField);
  const iField = findField(prototype, 'intensity');
  // Classification: not in the standard ASTM E2807 prototype, but
  // some exporters (CloudCompare, custom LIDAR pipelines) add a
  // `classification` Integer / ScaledInteger field. We honour it
  // when present so the splat shader's classification colour mode
  // works on those files. Stock Faro / Leica scans don't carry it
  // — that's why classification mode shows everything as class 0
  // (the spec maps that to "Created, never classified").
  const cField = findField(prototype, 'classification');
  return {
    xField, yField, zField,
    rField, gField, bField, hasRgb,
    // Any supported intensity kind (Float / Integer / ScaledInteger).
    iField,
    hasIntensity: !!iField && (iField.kind === 'Float' || iField.kind === 'Integer' || iField.kind === 'ScaledInteger'),
    cField,
    hasClassification: !!cField && (cField.kind === 'Integer' || cField.kind === 'ScaledInteger'),
  };
}

/** Lightweight 4-byte DataPacket header peek (type + total logical length). */
export interface PacketHeaderPeek {
  /** packetType: 1=data, 2=index, 3=empty. */
  packetType: number;
  /** Total packet length in logical bytes (header field + 1). */
  packetLength: number;
}

/**
 * Read a DataPacket's 4-byte header without decoding its payload. The
 * streaming reader uses this to learn a packet's length up front so it
 * can decide whether the packet fits in the current window before
 * committing to decode it.
 *
 * Packet header (4 bytes):
 *   byte 0:    packetType (1=data, 2=index, 3=empty)
 *   byte 1:    packetFlags (bit 0 = compressorRestart)
 *   bytes 2-3: packetLogicalLength - 1 (LE u16; total packet bytes minus 1)
 */
export function peekPacketHeader(view: DataView, offset: number): PacketHeaderPeek {
  return {
    packetType: view.getUint8(offset),
    packetLength: view.getUint16(offset + 2, true) + 1,
  };
}

/** Result of decoding a single DataPacket. */
export interface DecodedPacket {
  /** packetType: 1=data (positions populated), 2/3=skip (take=0). */
  packetType: number;
  /** Total packet length in logical bytes — advance the cursor by this. */
  packetLength: number;
  /** Records decoded into the channel buffers (0 for non-data packets). */
  take: number;
  /** take*3 cartesian floats (data packets only). */
  positions?: Float32Array;
  /** take*3 colour floats when the scan carries RGB. */
  colors?: Float32Array;
  /** take intensities when the scan carries intensity. */
  intensities?: Uint16Array;
  /** take classifications when the scan carries them. */
  classifications?: Uint8Array;
}

/**
 * Decode ONE DataPacket at `offset` in the logical-byte view `logical`.
 *
 * Non-data packets (index/empty) return `{ packetType, packetLength,
 * take: 0 }` so the caller can skip them by `packetLength`. Data packets
 * decode up to `maxRecords` consecutive records into freshly-allocated,
 * tightly-sized channel buffers — the caller owns striding, pose, and
 * concatenation.
 *
 * Callers must ensure `offset + 4 <= logical.length` (header readable)
 * before calling; this function then bounds-checks the full packet
 * against `logical.length` for data packets.
 */
export function decodeE57Packet(
  logical: Uint8Array,
  view: DataView,
  offset: number,
  fields: ScanFieldSet,
  prototype: PrototypeField[],
  maxRecords: number,
): DecodedPacket {
  const packetType = view.getUint8(offset);
  const packetLength = view.getUint16(offset + 2, true) + 1;
  if (packetType !== 1) {
    // Skip non-data packets (index/empty); they may appear interleaved.
    return { packetType, packetLength, take: 0 };
  }
  const packetEnd = offset + packetLength;
  if (packetEnd > logical.length) {
    throw new Error('E57: DataPacket runs past end of logical bytes');
  }
  // Data packet header beyond the common 4 bytes:
  //   byte 4..5: bytestreamCount (u16 LE)
  //   then `bytestreamCount` × u16 LE = bytestreamByteCount[]
  //   then payload (concatenated bytestreams, in prototype order)
  //
  // CRCs in E57 live at the PAGE level (4 bytes per 1024-byte
  // physical page, stripped by `stripPageCrc` before we get here).
  // There is no per-packet trailing CRC — the bytestreams fill the
  // packet exactly up to `packetEnd`. An earlier version of this
  // code subtracted 4 bytes assuming a packet-level CRC, which
  // false-positived the bounds checks below on real-world Faro /
  // Trimble exports whose last bytestream ends within the final
  // 4 bytes of the packet.
  const payloadEnd = packetEnd;
  if (offset + 6 > payloadEnd) {
    throw new Error('E57: truncated DataPacket header');
  }
  const bytestreamCount = view.getUint16(offset + 4, true);
  if (bytestreamCount !== prototype.length) {
    throw new Error(
      `E57: packet bytestreamCount (${bytestreamCount}) ≠ prototype length (${prototype.length})`,
    );
  }
  const bytestreamLengths: number[] = [];
  let cursor = offset + 6;
  for (let i = 0; i < bytestreamCount; i++) {
    if (cursor + 2 > payloadEnd) {
      throw new Error('E57: truncated bytestream length table');
    }
    bytestreamLengths.push(view.getUint16(cursor, true));
    cursor += 2;
  }
  const fieldOffsets = new Map<string, { start: number; length: number }>();
  let streamCursor = cursor;
  for (let i = 0; i < bytestreamCount; i++) {
    // Each bytestream must fit inside the packet payload — a corrupt
    // file could otherwise have us read into the next packet or
    // even past `logical`.
    if (streamCursor + bytestreamLengths[i] > payloadEnd) {
      throw new Error(
        `E57: bytestream ${prototype[i].name} (${bytestreamLengths[i]} bytes) `
        + `runs past packet payload at offset ${streamCursor}`,
      );
    }
    fieldOffsets.set(prototype[i].name, { start: streamCursor, length: bytestreamLengths[i] });
    streamCursor += bytestreamLengths[i];
  }

  // Per-axis packet capacity varies by field kind: Float uses
  // floor(length / byteSize), ScaledInteger uses floor(length * 8 /
  // bitsPerRecord). Take the min so a mixed-encoding packet picks
  // the shortest stream.
  const { xField, yField, zField } = fields;
  const xPos = fieldOffsets.get('cartesianX')!;
  const yPos = fieldOffsets.get('cartesianY')!;
  const zPos = fieldOffsets.get('cartesianZ')!;
  const xCapacity = floatOrSiPointCapacity(xField, xPos.length);
  const yCapacity = floatOrSiPointCapacity(yField, yPos.length);
  const zCapacity = floatOrSiPointCapacity(zField, zPos.length);
  const pointsInPacket = Math.min(xCapacity, yCapacity, zCapacity);
  const take = Math.min(pointsInPacket, Math.max(0, maxRecords));

  const positions = new Float32Array(take * 3);
  const colors = fields.hasRgb ? new Float32Array(take * 3) : undefined;
  const intensities = fields.hasIntensity ? new Uint16Array(take) : undefined;
  const classifications = fields.hasClassification ? new Uint8Array(take) : undefined;

  readCartesianStream(logical, view, xField, xPos.start, positions, 0, take, 0);
  readCartesianStream(logical, view, yField, yPos.start, positions, 0, take, 1);
  readCartesianStream(logical, view, zField, zPos.start, positions, 0, take, 2);

  if (colors && fields.rField && fields.gField && fields.bField) {
    writeColorChannel(view, fieldOffsets.get('colorRed')!.start, fields.rField, colors, 0, take, 0, logical);
    writeColorChannel(view, fieldOffsets.get('colorGreen')!.start, fields.gField, colors, 0, take, 1, logical);
    writeColorChannel(view, fieldOffsets.get('colorBlue')!.start, fields.bField, colors, 0, take, 2, logical);
  }
  if (intensities && fields.iField) {
    readIntensityStream(logical, view, fields.iField, fieldOffsets.get('intensity')!.start, intensities, 0, take);
  }
  if (classifications && fields.cField) {
    readClassificationStream(
      logical, view, fields.cField,
      fieldOffsets.get('classification')!.start,
      classifications, 0, take,
    );
  }

  return { packetType, packetLength, take, positions, colors, intensities, classifications };
}

/**
 * Decode the binary section starting at `entry.binaryFileOffset` in the
 * logical-bytes view. NOTE: `binaryFileOffset` here must already point
 * at the first DataPacket (i.e. AFTER the 32-byte CompressedVector
 * section header) — `decodeE57` does this conversion via
 * `resolveCompressedVectorDataOffset`. Callers passing the raw XML
 * offset directly will see a "bytestreamCount ≠ prototype length"
 * mismatch.
 *
 * Supports Float (single/double), ScaledInteger (bit-packed integer
 * with scale/offset), and Integer for cartesianX/Y/Z + colorRed/
 * Green/Blue + intensity. Other prototype fields are honoured for
 * stride math but discarded.
 *
 * Whole-file path: holds the entire scan in memory. The streaming
 * `E57StreamingSource` shares the per-packet primitives above but reads
 * the binary section incrementally so multi-GB files don't allocate the
 * whole file at once.
 */
export function decodeE57Scan(logical: Uint8Array, entry: Data3DEntry): DecodedPointChunk {
  const fields = resolveScanFields(entry.prototype);

  // Guard against a header (XML `recordCount`) that declares far more records
  // than the binary section can hold. The XML parser only rejects NaN/negative
  // counts (e57-xml.ts) — it has no access to the file length — so the
  // upper-bound-vs-body check lives here, where `logical` is in hand. Every
  // record occupies at least one bit in the packed bytestream, so recordCount
  // can never exceed `availableBytes * 8`. Without this, a small hostile file
  // could declare a huge count and force a multi-GB `Float32Array` allocation
  // (OOM) before the packet walk ever notices the body is short.
  const availableBytes = logical.length - entry.binaryFileOffset;
  if (!Number.isFinite(entry.recordCount) || entry.recordCount < 0) {
    throw new Error(`E57: invalid recordCount ${entry.recordCount}`);
  }
  if (availableBytes <= 0 || entry.recordCount > availableBytes * 8) {
    throw new Error(
      `E57: declared recordCount ${entry.recordCount} exceeds what the ` +
        `${Math.max(0, availableBytes)}-byte binary section can hold`,
    );
  }

  const positions = new Float32Array(entry.recordCount * 3);
  const colors = fields.hasRgb ? new Float32Array(entry.recordCount * 3) : undefined;
  const intensities = fields.hasIntensity ? new Uint16Array(entry.recordCount) : undefined;
  const classifications = fields.hasClassification ? new Uint8Array(entry.recordCount) : undefined;

  let offset = entry.binaryFileOffset;
  const view = new DataView(logical.buffer, logical.byteOffset, logical.byteLength);
  let written = 0;

  while (written < entry.recordCount && offset < logical.length) {
    if (offset + 4 > logical.length) {
      throw new Error('E57: truncated DataPacket header');
    }
    const packet = decodeE57Packet(logical, view, offset, fields, entry.prototype, entry.recordCount - written);
    if (packet.packetType !== 1) {
      offset += packet.packetLength;
      continue;
    }
    if (packet.take > 0 && packet.positions) {
      positions.set(packet.positions, written * 3);
      if (colors && packet.colors) colors.set(packet.colors, written * 3);
      if (intensities && packet.intensities) intensities.set(packet.intensities, written);
      if (classifications && packet.classifications) classifications.set(packet.classifications, written);
      written += packet.take;
    }
    offset += packet.packetLength;
  }

  if (written < entry.recordCount) {
    // Real-world files sometimes report counts a few records higher
    // than what's actually stored; trim positions to the actual count
    // so downstream code doesn't see uninitialised tail values.
    return finalize(
      positions.subarray(0, written * 3),
      colors?.subarray(0, written * 3),
      intensities?.subarray(0, written),
      classifications?.subarray(0, written),
      written,
    );
  }
  return finalize(positions, colors, intensities, classifications, entry.recordCount);
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
    // ScaledInteger colour: bit-packed integer normalised by the
    // declared min/max range. The "scale + offset" prototype attrs
    // still apply per spec but for colour they always normalise to
    // the declared range, so we just remap [minimum, maximum] → [0, 1]
    // like Integer colour does.
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
 * bit-pack walk plus per-record `(raw + minimum) * scale + offset`.
 *
 * `axis` selects which of the three position slots to write to
 * (0 = X, 1 = Y, 2 = Z).
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
  // ScaledInteger: stream stores `raw_int = (value - minimum)` as
  // an unsigned bit-pack; decoded float = (raw_int + minimum) * scale + offset.
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
 * Handles Float, Integer, and ScaledInteger kinds.
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
  // ScaledInteger intensity: range-remap from the bit-pack walk.
  const bitsPerRecord = scaledIntegerBitsPerRecord(field);
  const minimum = field.minimum ?? 0;
  const maximum = field.maximum ?? minimum;
  const span = maximum - minimum;
  const inv = span > 0 ? 1 / span : 1;
  const startBit = start * 8;
  for (let i = 0; i < take; i++) {
    const raw = readBitsLE(bytes, startBit + i * bitsPerRecord, bitsPerRecord);
    intensities[written + i] = Math.min(65535, Math.max(0, Math.round(raw * inv * 65535)));
  }
}

/**
 * E57 §6.3.4: bitsPerRecord = ceil(log2(maximum - minimum + 1)).
 * Caps at 53 bits (Number-precision limit). Real exporters top out
 * around 32 bits.
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

/** Float / Integer / ScaledInteger → max points that fit in `lengthBytes`. */
function floatOrSiPointCapacity(field: PrototypeField, lengthBytes: number): number {
  if (field.kind === 'Float') {
    const byteSize = field.precision === 'single' ? 4 : 8;
    return Math.floor(lengthBytes / byteSize);
  }
  if (field.kind === 'ScaledInteger') {
    const bits = scaledIntegerBitsPerRecord(field);
    return Math.floor((lengthBytes * 8) / bits);
  }
  // Integer: same width selection as writeColorChannel.
  const min = field.minimum ?? 0;
  const max = field.maximum ?? 255;
  const widest = Math.max(Math.abs(min), Math.abs(max));
  const byteSize = widest > 255 ? 2 : 1;
  return Math.floor(lengthBytes / byteSize);
}

/**
 * Read `bitsPerRecord` bits starting at `bitOffset` from `bytes`,
 * LSB-first within each byte (E57 spec convention). Uses
 * `Math.pow(2, n)` instead of `<< n` to keep precision up to 53 bits.
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
  classifications: Uint8Array | undefined,
  pointCount: number,
): DecodedPointChunk {
  return {
    positions: new Float32Array(positions),
    colors: colors ? new Float32Array(colors) : undefined,
    intensities: intensities ? new Uint16Array(intensities) : undefined,
    classifications: classifications ? new Uint8Array(classifications) : undefined,
    pointCount,
    bbox: computeBBox(positions),
  };
}

/**
 * Read N classification samples from a bytestream into a Uint8Array.
 * Handles the two encodings real exporters use: plain Integer (u8 /
 * u16 picked from declared range) and ScaledInteger (bit-packed).
 * Values are clamped into the u8 range — ASPRS LAS 1.4 only defines
 * up to class 18, so >255 is meaningless but we don't error on it.
 */
function readClassificationStream(
  bytes: Uint8Array,
  view: DataView,
  field: PrototypeField,
  start: number,
  classifications: Uint8Array,
  written: number,
  take: number,
): void {
  if (field.kind === 'Integer') {
    const min = field.minimum ?? 0;
    const max = field.maximum ?? 255;
    const widest = Math.max(Math.abs(min), Math.abs(max));
    const stride = widest > 255 ? 2 : 1;
    const signed = min < 0;
    for (let i = 0; i < take; i++) {
      const off = start + i * stride;
      const raw = stride === 2
        ? (signed ? view.getInt16(off, true) : view.getUint16(off, true))
        : (signed ? view.getInt8(off) : view.getUint8(off));
      // Class IDs are absolute labels (ASPRS LAS 1.4 0..31), not
      // range-normalised offsets. The raw byte IS the class — don't
      // subtract `minimum`. Mirrors the ScaledInteger branch below
      // which uses `raw + minimum` to recover the original value.
      classifications[written + i] = Math.max(0, Math.min(255, raw));
    }
    return;
  }
  // ScaledInteger: classification is conceptually an integer but
  // some exporters declare a scale anyway. Reader the raw bits and
  // ignore scale/offset (no real meaning for class IDs).
  const bitsPerRecord = scaledIntegerBitsPerRecord(field);
  const minimum = field.minimum ?? 0;
  const startBit = start * 8;
  for (let i = 0; i < take; i++) {
    const raw = readBitsLE(bytes, startBit + i * bitsPerRecord, bitsPerRecord);
    classifications[written + i] = Math.max(0, Math.min(255, raw + minimum));
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function computeBBox(positions: Float32Array): PointCloudBBox {
  // Empty / non-aligned input yields ±Infinity bounds, which poisons
  // camera fit-to-view and section-plane math downstream. Return a
  // finite zero-bbox instead.
  if (positions.length < 3) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let any = false;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    // Skip non-finite coords rather than letting them poison the bbox.
    // A single NaN/Infinity from a corrupt scan would otherwise propagate.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    any = true;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!any) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
