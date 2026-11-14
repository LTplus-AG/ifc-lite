/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Validate before typed-array assignment: Uint32Array otherwise silently wraps.
export function checkByteSpan(offset: number, length: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffff_ffff ||
      !Number.isInteger(length) || length < 0 || length > 0xffff_ffff) {
    throw new RangeError('Compact entity index byte offset/length must fit uint32');
  }
}
