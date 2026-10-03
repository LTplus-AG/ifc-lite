/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { bounds } from './contracts.js';

// Shallow scalar/owner walks; never scan vertex values during measurement.
// Typed views count their full backing buffer once, not only the view length.
export class Retention {
  private buffers = new Set<ArrayBufferLike>();
  private owners = new WeakSet<object>();
  bytes = 0;
  visits = 0;
  get bufferCount(): number { return this.buffers.size; }
  add(value: unknown, depth = 0): void {
    if (++this.visits > bounds.objectVisits || depth > 24) throw new Error('retention work bound');
    if (value === null || typeof value !== 'object') return;
    if (ArrayBuffer.isView(value)) { this.buffer(value.buffer); return; }
    if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
      this.buffer(value); return;
    }
    if (this.owners.has(value)) return;
    this.owners.add(value);
    if (value instanceof Map) {
      for (const [key, item] of value) { this.add(key, depth + 1); this.add(item, depth + 1); }
    } else if (Array.isArray(value)) {
      for (const item of value) this.add(item, depth + 1);
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('unsupported retained owner');
      for (const item of Object.values(value)) this.add(item, depth + 1);
    }
  }
  private buffer(buffer: ArrayBufferLike): void {
    if (this.buffers.has(buffer)) return;
    if (this.buffers.size >= bounds.buffers || this.bytes + buffer.byteLength > bounds.retainedBytes) {
      throw new Error('retained backing-buffer bound');
    }
    this.buffers.add(buffer);
    this.bytes += buffer.byteLength;
  }
  release(): void { this.buffers.clear(); this.owners = new WeakSet<object>(); }
}
