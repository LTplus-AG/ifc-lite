/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RhinoBufferRef } from './types.js';

/**
 * Sections are aligned relative to the blob; a caller's backing-store view may not be.
 * `new Uint8Array` always copies; a Node Buffer's `slice()` would return an unaligned view.
 */
export function alignedRhinoBlob(blob: Uint8Array): Uint8Array {
  return blob.byteOffset % 8 === 0 ? blob : new Uint8Array(blob);
}

/** View a validated section of an aligned scene blob without copying it. */
export function sectionView<T>(
  blob: Uint8Array,
  ref: RhinoBufferRef,
  Ctor: new (buffer: ArrayBufferLike, byteOffset: number, length: number) => T,
): T {
  return new Ctor(blob.buffer, blob.byteOffset + ref.offset, ref.count);
}
