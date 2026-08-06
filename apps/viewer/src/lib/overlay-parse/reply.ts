/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reply construction for the overlay-parse worker, split out from the worker
 * itself so it is unit-testable (importing the worker module would run its
 * `self.onmessage` registration).
 */

import type { OverlayParseResponse } from './overlay-parse.worker.js';
import type { FlatSymbolic } from './symbolic-flat.js';

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

/**
 * Same two rules as {@link buildParseReply}, applied across the ~20 buffers a
 * `FlatSymbolic` carries.
 *
 * The zero-length exclusion does real work here rather than being belt-and-
 * braces: a model with grids but no fills produces several genuinely empty
 * arrays every time, so without it the FIRST symbolic reply would detach them
 * and a second job in the same worker would throw `DataCloneError`.
 *
 * Buffers are de-duplicated by identity because a correct flatten may share
 * one backing buffer between two views, and transferring the same
 * `ArrayBuffer` twice throws.
 */
export function buildSymbolicReply(id: number, flat: FlatSymbolic): BuiltReply {
  const transfer: ArrayBuffer[] = [];
  const seen = new Set<ArrayBuffer>();
  for (const value of Object.values(flat)) {
    if (!ArrayBuffer.isView(value)) continue;
    if (value.byteLength === 0) continue;
    const buffer = value.buffer as ArrayBuffer;
    if (seen.has(buffer)) continue;
    seen.add(buffer);
    transfer.push(buffer);
  }
  return { reply: { id, ok: true, flat }, transfer };
}
