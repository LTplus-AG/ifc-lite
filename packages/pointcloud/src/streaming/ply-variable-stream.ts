/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PlyPropertyOrderEntry } from '../formats/ply.js';
import { readPlyScalar } from '../formats/ply-scalar.js';

const READ_BYTES = 4 * 1024 * 1024;

/** Bounded sequential traversal for binary PLY rows containing variable-length lists. */
export class BinaryPlyRowCursor {
  private offset: number;
  private window = new Uint8Array(0);
  private windowOffset = 0;

  constructor(private readonly blob: Blob, bodyOffset: number, private readonly littleEndian: boolean) {
    this.offset = bodyOffset;
  }

  async row(order: readonly PlyPropertyOrderEntry[], row: number, signal?: AbortSignal): Promise<Map<string, number>> {
    const values = new Map<string, number>();
    for (const entry of order) {
      if (entry.kind === 'scalar') {
        const bytes = await this.take(entry.property.size, row, signal);
        values.set(entry.property.name, readPlyScalar(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0, entry.property, this.littleEndian));
        continue;
      }
      const countBytes = await this.take(entry.countSize, row, signal);
      const count = readPlyScalar(new DataView(countBytes.buffer, countBytes.byteOffset, countBytes.byteLength), 0, { type: entry.countType }, this.littleEndian);
      const byteCount = count * entry.itemSize;
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(byteCount)) throw new Error(`PLY binary: vertex row ${row + 1} has an invalid ${entry.name} list`);
      await this.skip(byteCount, row, signal);
    }
    return values;
  }

  private async take(length: number, row: number, signal?: AbortSignal): Promise<Uint8Array> {
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      await this.refill(signal);
      const available = this.window.length - this.windowOffset;
      if (available === 0) throw new Error(`PLY binary: vertex row ${row + 1} is truncated`);
      const count = Math.min(length - written, available);
      output.set(this.window.subarray(this.windowOffset, this.windowOffset + count), written);
      this.windowOffset += count; written += count;
    }
    return output;
  }

  private async skip(length: number, row: number, signal?: AbortSignal): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      await this.refill(signal);
      const available = this.window.length - this.windowOffset;
      if (available === 0) throw new Error(`PLY binary: vertex row ${row + 1} list is truncated`);
      const count = Math.min(remaining, available);
      this.windowOffset += count; remaining -= count;
    }
  }

  private async refill(signal?: AbortSignal): Promise<void> {
    if (this.windowOffset < this.window.length) return;
    signal?.throwIfAborted();
    const end = Math.min(this.blob.size, this.offset + READ_BYTES);
    this.window = new Uint8Array(await this.blob.slice(this.offset, end).arrayBuffer());
    this.offset = end; this.windowOffset = 0;
    signal?.throwIfAborted();
  }
}
