/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Byte-range reader backed by a Blob.
 *
 * Works for both browser `File` objects (drag-and-drop) and `fetch()`
 * responses materialised via `await response.blob()`. Reads return
 * `Uint8Array` — the underlying ArrayBuffer is owned by the caller and
 * safe to transfer across postMessage boundaries.
 */
export class BlobByteSource {
  constructor(private readonly blob: Blob) {}

  get size(): number {
    return this.blob.size;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    const safeEnd = Math.min(end, this.blob.size);
    if (safeEnd <= start) return new Uint8Array(0);
    const slice = this.blob.slice(start, safeEnd);
    const buf = await slice.arrayBuffer();
    return new Uint8Array(buf);
  }
}
