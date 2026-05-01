/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * E57 binary-section decoder for a single Data3D scan.
 *
 * Walks DataPackets at `entry.binaryFileOffset` (in the LOGICAL
 * post-CRC view) and decodes per-record bytestreams as Float32 /
 * Float64 / Integer columns. ScaledInteger throws a clear error so
 * callers can guide users to a Float-encoded export.
 */

import type { DecodedPointChunk, PointCloudBBox } from '../types.js';
import { findField, type Data3DEntry, type PrototypeField } from './e57-xml.js';

/**
 * Decode the binary section starting at `entry.binaryFileOffset` in the
 * logical-bytes view. NOTE: `binaryFileOffset` here must already point
 * at the first DataPacket (i.e. AFTER the 32-byte CompressedVector
 * section header) — `decodeE57` does this conversion via
 * `resolveCompressedVectorDataOffset`. Callers passing the raw XML
 * offset directly will see a "bytestreamCount ≠ prototype length"
 * mismatch.
 *
 * Limitations:
 *   - Only Float (single/double) cartesian fields. ScaledInteger throws.
 *   - Reads cartesianX/Y/Z + colorRed/Green/Blue + intensity when
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
  let offset = entry.binaryFileOffset;
  const view = new DataView(logical.buffer, logical.byteOffset, logical.byteLength);
  let written = 0;

  while (written < entry.recordCount && offset < logical.length) {
    if (offset + 4 > logical.length) {
      throw new Error('E57: truncated DataPacket header');
    }
    const packetType = view.getUint8(offset);
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
    //   then 4 bytes of trailing CRC (ignored).
    const payloadEnd = packetEnd - 4;
    if (offset + 6 > payloadEnd) {
      throw new Error('E57: truncated DataPacket header');
    }
    const bytestreamCount = view.getUint16(offset + 4, true);
    if (bytestreamCount !== entry.prototype.length) {
      throw new Error(
        `E57: packet bytestreamCount (${bytestreamCount}) ≠ prototype length (${entry.prototype.length})`,
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
          `E57: bytestream ${entry.prototype[i].name} (${bytestreamLengths[i]} bytes) `
          + `runs past packet payload at offset ${streamCursor}`,
        );
      }
      fieldOffsets.set(entry.prototype[i].name, { start: streamCursor, length: bytestreamLengths[i] });
      streamCursor += bytestreamLengths[i];
    }

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
      for (let i = 0; i < take; i++) positions[(written + i) * 3] = view.getFloat32(xStart + i * 4, true);
    } else {
      for (let i = 0; i < take; i++) positions[(written + i) * 3] = view.getFloat64(xStart + i * 8, true);
    }
    if (yField.precision === 'single') {
      for (let i = 0; i < take; i++) positions[(written + i) * 3 + 1] = view.getFloat32(yStart + i * 4, true);
    } else {
      for (let i = 0; i < take; i++) positions[(written + i) * 3 + 1] = view.getFloat64(yStart + i * 8, true);
    }
    if (zField.precision === 'single') {
      for (let i = 0; i < take; i++) positions[(written + i) * 3 + 2] = view.getFloat32(zStart + i * 4, true);
    } else {
      for (let i = 0; i < take; i++) positions[(written + i) * 3 + 2] = view.getFloat64(zStart + i * 8, true);
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
