/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CompressedSource } from '@ifc-lite/parser';

function sharedMemoryAvailable(): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  return (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false;
}

/**
 * Move the compressed blocks into a SharedArrayBuffer when the realm allows it.
 *
 * A compacted source hands itself to workers as its blocks
 * (`IfcSourceBytes.toTransferable`, used by every overlay parse). An
 * ArrayBuffer-backed block array would be structured-cloned on each of those
 * posts (~67 MB on the 343 MB reference model); a shared one crosses by
 * reference, exactly as the resident SAB source did before compaction. The
 * copy here is one-off, in the worker, at ~20% of the source size.
 */
export function shareCompressedBlocks(payload: CompressedSource): CompressedSource {
  if (!sharedMemoryAvailable() || payload.blocks.buffer instanceof SharedArrayBuffer) return payload;
  const shared = new Uint8Array(new SharedArrayBuffer(payload.blocks.byteLength));
  shared.set(payload.blocks);
  return { ...payload, blocks: shared };
}
