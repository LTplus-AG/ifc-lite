/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CompressedSource } from '@ifc-lite/parser';

/**
 * One whole-source compression job. `bytes` is the model's resident source: a
 * SharedArrayBuffer-backed view on the paths that matter, so posting it shares
 * the memory instead of cloning it. It must never be put in a transfer list —
 * that would detach the store's own bytes before the swap.
 */
export interface SourceCompressionRequest {
  id: number;
  bytes: Uint8Array;
}

export type SourceCompressionResponse =
  | { id: number; ok: true; payload: CompressedSource }
  | { id: number; ok: false; message: string };
