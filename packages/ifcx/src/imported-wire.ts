/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { runImportedPacket } from './imported-kernel.js';

/** Internal binary transport; never performs geometry arithmetic. */
export class ImportWriter {
  private bytes = new Uint8Array(256);
  private offset = 0;
  private view = new DataView(this.bytes.buffer);
  constructor(kind: number) { this.u32(1); this.u32(kind); }
  private reserve(size: number): DataView {
    const needed = this.offset + size;
    if (!Number.isSafeInteger(needed) || needed > 0xffff_ffff) throw new RangeError('Imported geometry packet exceeds addressable memory');
    if (needed > this.bytes.length) {
      const next = new Uint8Array(Math.max(needed, Math.min(0xffff_ffff, this.bytes.length * 2)));
      next.set(this.bytes); this.bytes = next; this.view = new DataView(next.buffer);
    }
    return this.view;
  }
  u32(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError('Imported geometry uint32 overflow');
    this.reserve(4).setUint32(this.offset, value, true); this.offset += 4; return this;
  }
  u64(value: number): this { this.reserve(8).setBigUint64(this.offset, BigInt(value), true); this.offset += 8; return this; }
  f64(value: number): this { this.reserve(8).setFloat64(this.offset, value, true); this.offset += 8; return this; }
  string(value: string): this {
    const text = new TextEncoder().encode(value); this.u32(text.length); this.reserve(text.length);
    this.bytes.set(text, this.offset); this.offset += text.length; return this;
  }
  // JSON string serialization is injective over JavaScript UTF-16, including
  // isolated surrogates which TextEncoder alone would replace with U+FFFD.
  identityString(value: string): this { return this.string(JSON.stringify(value)); }
  optionalString(value: string | undefined): this { this.u32(value === undefined ? 0 : 1); if (value !== undefined) this.string(value); return this; }
  values(values: ArrayLike<number>): this { this.u32(values.length); for (let i = 0; i < values.length; i++) this.f64(values[i]); return this; }
  rows(rows: readonly (readonly number[])[]): this { this.u32(rows.length); for (const row of rows) this.values(row); return this; }
  matrix(rows: readonly (readonly number[])[]): this {
    this.u32(4);
    for (let row = 0; row < 4; row++) {
      this.u32(4);
      for (let col = 0; col < 4; col++) this.f64(rows[row]?.[col] ?? (row === col ? 1 : 0));
    }
    return this;
  }
  run(): ImportReader { return new ImportReader(runImportedPacket(this.bytes.subarray(0, this.offset))); }
}
export class ImportReader {
  private offset = 8;
  private view: DataView;
  constructor(private bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  u32(): number { const value = this.view.getUint32(this.offset, true); this.offset += 4; return value; }
  u64(): number {
    const value = this.view.getBigUint64(this.offset, true); this.offset += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Imported geometry identity exceeds safe integer');
    return Number(value);
  }
  f64(): number { const value = this.view.getFloat64(this.offset, true); this.offset += 8; return value; }
  string(): string {
    const length = this.u32(); const text = new TextDecoder().decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length; return text;
  }
  identityString(): string {
    const value: unknown = JSON.parse(this.string());
    if (typeof value !== 'string') throw new Error('Imported geometry: malformed source identity');
    return value;
  }
  optionalIdentityString(): string | undefined { return this.u32() ? this.identityString() : undefined; }
  optionalString(): string | undefined { return this.u32() ? this.string() : undefined; }
  floats(): Float32Array {
    const length = this.u32(); const output = new Float32Array(length); const bits = new Uint32Array(output.buffer);
    for (let i = 0; i < length; i++) bits[i] = this.u32();
    return output;
  }
  indices(): Uint32Array {
    const length = this.u32(); const output = new Uint32Array(length);
    for (let i = 0; i < length; i++) output[i] = this.u32();
    return output;
  }
  triple(): [number, number, number] { return [this.f64(), this.f64(), this.f64()]; }
}
