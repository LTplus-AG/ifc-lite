/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** WASM getter declarations use ArrayBufferLike; transfers require owned backing.
 * The real WASM ownership contract covers free(), memory growth and transfer. */
export function ownedWasmBuffer(array: ArrayBufferView): ArrayBuffer {
  const buffer = array.buffer;
  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error('WASM mesh getter returned non-transferable backing');
  }
  return buffer;
}
