/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Exclusive source-size boundary: wasm32 Rust Vec/slices cannot exceed isize::MAX.
 * setSourceBytes takes a whole-source Vec<u8> before geometry work begins.
 * Smaller sources may still exhaust memory; this is not a memory budget. */
export const WASM_SOURCE_BYTE_LIMIT = 2 ** 31;

export class WasmSourceSizeError extends RangeError {
  constructor() {
    super(`IFC source must be smaller than ${WASM_SOURCE_BYTE_LIMIT} bytes`);
    this.name = 'WasmSourceSizeError';
  }
}

export function assertWasmSourceSize(byteLength: number): void {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new RangeError('IFC source byte length must be a finite non-negative integer');
  }
  if (byteLength >= WASM_SOURCE_BYTE_LIMIT) throw new WasmSourceSizeError();
}
