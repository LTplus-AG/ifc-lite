/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Largest input the reader accepts. Measured, not guessed: in Node 22 with
 * rhino3dm 8.35.0 a 403 MB file of dense double-precision meshes read with the
 * wasm heap at 1,885 MB of its 2,048 MB limit, 429 MB reached 1,964 MB, and
 * 477 MB failed at the limit. The table is under "Size ceiling" in
 * docs/architecture/rhino-3dm-import.md. A file under the cap can still run
 * out of memory when its content expands more; that is reported the same way.
 *
 * This module imports nothing, so a caller on a page's main thread can ask the
 * cap before it hands the bytes to a worker without loading rhino3dm.
 */
export const MAX_3DM_BYTES = 400 * 1024 * 1024;

const MIB = 1024 * 1024;

/**
 * The `too-large` refusal for an archive above `MAX_3DM_BYTES`. The size
 * rounds up, so a file just over the cap never reads as the cap itself.
 */
export function tooLarge3dmMessage(byteLength: number): string {
  return `This file is ${Math.ceil(byteLength / MIB)} MB; the reader handles up to ${MAX_3DM_BYTES / MIB} MB. Split the model into smaller files in Rhino.`;
}
