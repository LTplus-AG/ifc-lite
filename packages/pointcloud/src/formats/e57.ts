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

/**
 * Per-scan pose: rotation (unit quaternion w + xi + yj + zk) +
 * translation (in source-frame metres). Optional because most
 * single-scan exports don't need one — when absent we treat the
 * scan as already in the file's global frame (identity pose).
 */
export interface E57Pose {
  rotation: { w: number; x: number; y: number; z: number };
  translation: { x: number; y: number; z: number };
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
   * Per-Data3D pose that places the scan into the file's global
   * frame. Applied by `decodeE57` before merging multi-scan files;
   * single-scan files where the pose is identity / absent need no
   * extra work either way.
   */
  pose?: E57Pose;
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
      pose: parsePoseElement(childByName(scan, 'pose')) ?? undefined,
    });
  }
  return entries;
}

/**
 * Parse a `<pose>` element to a quaternion + translation pair.
 * Returns null when the element is missing or malformed (any field
 * unparseable → fall back to identity rather than reject the file).
 *
 * Spec layout (E57 §6.6.3):
 *   <pose>
 *     <rotation> <w/> <x/> <y/> <z/> </rotation>
 *     <translation> <x/> <y/> <z/> </translation>
 *   </pose>
 *
 * The quaternion uses Hamilton convention (w + xi + yj + zk) and is
 * expected to be unit-length. Translation is in the same units as
 * the cartesian fields (metres for typical exporters).
 */
function parsePoseElement(poseEl: ReturnType<typeof childByName>): E57Pose | null {
  if (!poseEl) return null;
  const rotation = childByName(poseEl, 'rotation');
  const translation = childByName(poseEl, 'translation');
  if (!rotation || !translation) return null;
  const qw = Number(textChild(rotation, 'w') ?? '1');
  const qx = Number(textChild(rotation, 'x') ?? '0');
  const qy = Number(textChild(rotation, 'y') ?? '0');
  const qz = Number(textChild(rotation, 'z') ?? '0');
  const tx = Number(textChild(translation, 'x') ?? '0');
  const ty = Number(textChild(translation, 'y') ?? '0');
  const tz = Number(textChild(translation, 'z') ?? '0');
  if (![qw, qx, qy, qz, tx, ty, tz].every(Number.isFinite)) return null;
  return {
    rotation: { w: qw, x: qx, y: qy, z: qz },
    translation: { x: tx, y: ty, z: tz },
  };
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
  // Bit-packed (ScaledInteger) intensity isn't supported yet — surface
  // the limitation explicitly rather than silently dropping it.
  if (iField && iField.kind === 'ScaledInteger') {
    throw new Error(
      'E57: intensity encoded as ScaledInteger (bit-packed integer codec not yet supported)',
    );
  }

  const positions = new Float32Array(entry.recordCount * 3);
  const colors = hasRgb ? new Float32Array(entry.recordCount * 3) : undefined;
  // Allocate intensity buffer for both Float and Integer kinds — only
  // ScaledInteger is unsupported (rejected above). Otherwise
  // Integer-encoded intensity (common with u16-range producers) was
  // silently dropped.
  const intensities = iField && (iField.kind === 'Float' || iField.kind === 'Integer')
    ? new Uint16Array(entry.recordCount)
    : undefined;

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
      if (iField.kind === 'Float') {
        const stride = iField.precision === 'single' ? 4 : 8;
        for (let i = 0; i < take; i++) {
          const v = stride === 4 ? view.getFloat32(iStart + i * stride, true) : view.getFloat64(iStart + i * stride, true);
          intensities[written + i] = Math.min(65535, Math.max(0, Math.round(v * 65535)));
        }
      } else {
        // Integer-encoded intensity — pick element width from declared
        // range (same logic as the integer color channels).
        const min = iField.minimum ?? 0;
        const max = iField.maximum ?? 65535;
        const span = max - min;
        const inv = span > 0 ? 1 / span : 1;
        const widest = Math.max(Math.abs(min), Math.abs(max));
        const stride = widest > 255 ? 2 : 1;
        const signed = min < 0;
        for (let i = 0; i < take; i++) {
          const off = iStart + i * stride;
          const raw = stride === 2
            ? (signed ? view.getInt16(off, true) : view.getUint16(off, true))
            : (signed ? view.getInt8(off) : view.getUint8(off));
          const norm = (raw - min) * inv;
          intensities[written + i] = Math.min(65535, Math.max(0, Math.round(norm * 65535)));
        }
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

/**
 * Apply a per-scan pose (rotation quaternion + translation) to a
 * positions buffer in place: `out = R * in + T`.
 *
 * The quaternion is in Hamilton convention (w + xi + yj + zk); we
 * derive the 3×3 rotation matrix once and reuse it across every
 * point in the chunk. Translation is added after rotation.
 *
 * Quaternion → rotation matrix (assumes unit length; spec calls
 * for normalised input):
 *   r00 = 1 − 2(y² + z²)   r01 = 2(xy − wz)       r02 = 2(xz + wy)
 *   r10 = 2(xy + wz)       r11 = 1 − 2(x² + z²)   r12 = 2(yz − wx)
 *   r20 = 2(xz − wy)       r21 = 2(yz + wx)       r22 = 1 − 2(x² + y²)
 */
export function applyPoseInPlace(
  positions: Float32Array,
  pointCount: number,
  pose: E57Pose,
): void {
  const { w, x, y, z } = pose.rotation;
  const tx = pose.translation.x;
  const ty = pose.translation.y;
  const tz = pose.translation.z;
  const r00 = 1 - 2 * (y * y + z * z);
  const r01 = 2 * (x * y - w * z);
  const r02 = 2 * (x * z + w * y);
  const r10 = 2 * (x * y + w * z);
  const r11 = 1 - 2 * (x * x + z * z);
  const r12 = 2 * (y * z - w * x);
  const r20 = 2 * (x * z - w * y);
  const r21 = 2 * (y * z + w * x);
  const r22 = 1 - 2 * (x * x + y * y);
  for (let i = 0; i < pointCount; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    positions[i * 3]     = r00 * px + r01 * py + r02 * pz + tx;
    positions[i * 3 + 1] = r10 * px + r11 * py + r12 * pz + ty;
    positions[i * 3 + 2] = r20 * px + r21 * py + r22 * pz + tz;
  }
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

  // Resolve every entry's binary file offset through the
  // CompressedVector section header. The XML's fileOffset is the
  // section header (physical), not the first DataPacket.
  // Per-Data3D pose (when present) places each scan in the file's
  // global frame: `global = R * local + T`. We apply it here, after
  // decoding but before merging, so multi-scan registered E57s line
  // up correctly. Identity / absent poses are no-ops.
  const chunks = entries.map((entry) => {
    const dataLogicalOffset = resolveCompressedVectorDataOffset(
      logical,
      entry.binaryFileOffset,
      header.pageSize,
    );
    const chunk = decodeE57Scan(logical, { ...entry, binaryFileOffset: dataLogicalOffset });
    if (entry.pose) {
      applyPoseInPlace(chunk.positions, chunk.pointCount, entry.pose);
      // bbox needs to be recomputed since positions moved.
      chunk.bbox = computeBBox(chunk.positions);
    }
    return chunk;
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
