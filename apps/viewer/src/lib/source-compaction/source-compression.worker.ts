/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deflates a loaded model's IFC source into the 64 KiB blocks `BlockStore`
 * reads (#2183). Runs once per compacted model, after the load completed, and
 * is terminated by its client as soon as it answers.
 */

import { compressSource } from '@ifc-lite/parser';
import type { SourceCompressionRequest, SourceCompressionResponse } from './source-compression-protocol.js';
import { shareCompressedBlocks } from './shared-blocks.js';

const post = (message: SourceCompressionResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = (event: MessageEvent<SourceCompressionRequest>) => {
  const { id, bytes } = event.data;
  try {
    const payload = shareCompressedBlocks(compressSource(bytes));
    // `index` and `storedMask` are small and owned here, so transfer them. The
    // blocks are shared (see shareCompressedBlocks) unless SAB is unavailable,
    // in which case the owned buffer is transferred instead of cloned.
    const transfer: Transferable[] = [payload.index.buffer, payload.storedMask.buffer];
    if (payload.blocks.buffer instanceof ArrayBuffer) transfer.push(payload.blocks.buffer);
    post({ id, ok: true, payload }, transfer);
  } catch (error) {
    post({ id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};
