/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * E57 (ASTM E2807-11) reader — top-level orchestrator.
 *
 * Pulls the file-header / page-CRC handling from `e57-page.ts`, the
 * XML model from `e57-xml.ts`, and the per-scan binary decoder from
 * `e57-decode.ts`. Re-exports the public surface so existing callers
 * (`@ifc-lite/pointcloud` index, the streaming source, tests) keep
 * working.
 *
 * Scope:
 *   - Single-scan + multi-scan files. Per-Data3D pose (quaternion +
 *     translation) is applied before merging so registered scans
 *     line up in the file's global frame.
 *   - Float (single/double) AND ScaledInteger (bit-packed integer
 *     with scale/offset per E57 §6.3.4) for cartesian fields.
 *   - Integer / Float / ScaledInteger colour + intensity channels.
 *
 * Out of scope (deferred — see issue #611):
 *   - Spherical coordinate prototypes.
 */

import type { DecodedPointChunk } from '../types.js';
import {
  parseE57FileHeader,
  resolveCompressedVectorDataOffset,
  stripPageCrc,
} from './e57-page.js';
import { parseE57Xml, type E57Pose } from './e57-xml.js';
import { computeBBox, decodeE57Scan } from './e57-decode.js';

const TEXT_DECODER = new TextDecoder();

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
  // global frame: `global = R * local + T`. We apply it after
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
      chunk.bbox = computeBBox(chunk.positions);
    }
    return chunk;
  });
  if (chunks.length === 1) return chunks[0];

  // Concatenate. `some()` checks per channel so a single scan that
  // lacks color/intensity doesn't drop the channel for the whole
  // merged cloud — we just leave its slice at the default zeros.
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

/**
 * Apply a per-scan pose (rotation quaternion + translation) to a
 * positions buffer in place: `out = R · in + T`.
 *
 * Quaternion is in Hamilton convention (w + xi + yj + zk); we derive
 * the 3×3 rotation matrix once and reuse across every point in the
 * chunk. Translation is added after rotation.
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

// Re-export the public API so existing imports keep working.
export {
  parseE57FileHeader,
  stripPageCrc,
  resolveCompressedVectorDataOffset,
  type E57FileHeader,
} from './e57-page.js';
export {
  parseE57Xml,
  type Data3DEntry,
  type E57Pose,
} from './e57-xml.js';
export { decodeE57Scan } from './e57-decode.js';
