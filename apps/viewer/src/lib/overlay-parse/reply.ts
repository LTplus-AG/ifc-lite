/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reply construction for the overlay-parse worker, split out from the worker
 * itself so it is unit-testable (importing the worker module would run its
 * `self.onmessage` registration).
 */

import type { OverlayParseResponse } from './overlay-parse.worker.js';

export interface BuiltReply {
  reply: OverlayParseResponse;
  transfer: ArrayBuffer[];
}

/**
 * Wrap parse output in a reply plus its transfer list.
 *
 * Two rules, both of which exist because one worker serves several concurrent
 * jobs (grid + alignment) before it is terminated:
 *
 *   1. A no-result parse gets a FRESH array, never a shared module-level
 *      constant. Transferring a shared empty array detaches it, and the next
 *      empty reply from the same worker would then throw `DataCloneError` and
 *      be surfaced as a parse failure.
 *   2. A zero-length buffer is never put in the transfer list. There is
 *      nothing to move, and it keeps rule 1 from being load-bearing.
 */
export function buildParseReply(id: number, verts: Float32Array | null | undefined): BuiltReply {
  const payload = verts && verts.length > 0 ? verts : new Float32Array(0);
  return {
    reply: { id, ok: true, verts: payload },
    transfer: payload.byteLength > 0 ? [payload.buffer as ArrayBuffer] : [],
  };
}
