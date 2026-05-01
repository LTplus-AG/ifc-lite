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
 *   - Single-scan files OR multi-scan files where no Data3D defines a
 *     `<pose>` element. Multi-scan with poses is rejected up front
 *     because we don't yet apply the per-scan transforms.
 *   - Float (single/double) AND ScaledInteger (bit-packed integer
 *     with scale/offset per E57 §6.3.4) for cartesian fields.
 *   - Integer / Float / ScaledInteger colour + intensity channels.
 *
 * Out of scope (deferred — see issue #611):
 *   - Multi-scan pose merging.
 *   - Spherical coordinate prototypes.
 */

import type { DecodedPointChunk } from '../types.js';
import {
  parseE57FileHeader,
  resolveCompressedVectorDataOffset,
  stripPageCrc,
} from './e57-page.js';
import { parseE57Xml } from './e57-xml.js';
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
} from './e57-xml.js';
export { decodeE57Scan } from './e57-decode.js';
