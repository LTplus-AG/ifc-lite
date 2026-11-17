/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isCopcHeader, parsePcdHeader, type DecodeWorkerFormat } from '@ifc-lite/pointcloud';

import { detectPointCloudFormat } from '@/hooks/ingest/pointCloudIngest';

/** Compression is content, not a filename convention (including renamed COPC). */
export function positionedScanFormat(name: string, header: ArrayBuffer): DecodeWorkerFormat | null {
  const format = detectPointCloudFormat(name, header);
  if (format !== 'las' && format !== 'laz') return format;
  const bytes = new Uint8Array(header);
  return isCopcHeader(bytes) || (bytes.length > 104 && (bytes[104] & 0x80) !== 0) ? 'laz' : 'las';
}

/** Existing PCD/text readers materialize their input; LAZ buffers compressed
 * bytes. Bound those allocations BEFORE opening the worker source. LAS, PLY
 * and E57 use bounded reads. These are export limits, not viewer load limits. */
export async function preflightPositionedScan(file: Blob, format: DecodeWorkerFormat, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (['pcd', 'pts', 'xyz'].includes(format) && file.size > 16 * 1024 * 1024) {
    throw new Error('PCD, PTS and XYZ export currently requires an input of at most 16 MiB. Use a streaming LAS, PLY or E57 source for larger scans.');
  }
  if (format === 'laz' && file.size > 64 * 1024 * 1024) throw new Error('LAZ export currently requires compressed input of at most 64 MiB.');
  if (format !== 'pcd') return;
  const bytes = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  signal.throwIfAborted();
  const header = parsePcdHeader(bytes);
  const expanded = header.pointCount * header.pointStride;
  if (header.pointCount > 1_000_000 || expanded > 64 * 1024 * 1024) throw new Error('PCD export exceeds the one-million-point or 64 MiB decoded input limit.');
  if (header.data === 'binary_compressed') {
    const sizes = await file.slice(header.bodyOffset, header.bodyOffset + 8).arrayBuffer();
    signal.throwIfAborted();
    if (sizes.byteLength !== 8 || new DataView(sizes).getUint32(4, true) !== expanded) throw new Error('Inconsistent compressed PCD size.');
  }
}
