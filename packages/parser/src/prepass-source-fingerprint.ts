/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Read once without waiting. The cell is fresh for this source/request. */
export function readPrepassFingerprint(cell: SharedArrayBuffer | undefined, byteLength: number): string | undefined {
  if (!cell || cell.byteLength !== 16 || byteLength === 0) return undefined;
  const words = new Uint32Array(cell);
  if (Atomics.load(words, 3) !== 1 || words[0] + words[1] * 0x100000000 !== byteLength) return undefined;
  return `${byteLength.toString(16)}-${Atomics.load(words, 2).toString(16)}`;
}
