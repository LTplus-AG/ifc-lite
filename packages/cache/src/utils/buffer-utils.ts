/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Buffer utilities for reading/writing binary data
 */

/**
 * Writer for building binary buffers
 */
export class BufferWriter {
  private chunks: Uint8Array[] = [];
  private currentChunk: Uint8Array;
  private view: DataView;
  private offset: number = 0;
  private totalSize: number = 0;

  constructor(initialSize: number = 1024 * 1024) {
    this.currentChunk = new Uint8Array(initialSize);
    this.view = new DataView(this.currentChunk.buffer);
  }

  private ensureCapacity(bytes: number): void {
    if (this.offset + bytes > this.currentChunk.length) {
      // Save current chunk and create new one
      this.chunks.push(this.currentChunk.subarray(0, this.offset));
      this.totalSize += this.offset;

      const newSize = Math.max(bytes, this.currentChunk.length);
      this.currentChunk = new Uint8Array(newSize);
      this.view = new DataView(this.currentChunk.buffer);
      this.offset = 0;
    }
  }

  writeUint8(value: number): void {
    this.ensureCapacity(1);
    this.currentChunk[this.offset++] = value;
  }

  writeUint16(value: number): void {
    this.ensureCapacity(2);
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  writeUint32(value: number): void {
    this.ensureCapacity(4);
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }

  writeInt32(value: number): void {
    this.ensureCapacity(4);
    this.view.setInt32(this.offset, value, true);
    this.offset += 4;
  }

  writeBigUint64(value: bigint): void {
    this.ensureCapacity(8);
    this.view.setBigUint64(this.offset, value, true);
    this.offset += 8;
  }

  writeFloat32(value: number): void {
    this.ensureCapacity(4);
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
  }

  writeFloat64(value: number): void {
    this.ensureCapacity(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  writeBytes(data: Uint8Array): void {
    this.ensureCapacity(data.length);
    this.currentChunk.set(data, this.offset);
    this.offset += data.length;
  }

  writeTypedArray(arr: TypedArray): void {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    this.writeBytes(bytes);
  }

  writeString(str: string): void {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    this.writeUint32(bytes.length);
    this.writeBytes(bytes);
  }

  /** Pad to alignment boundary */
  align(boundary: number): void {
    const currentPos = this.totalSize + this.offset;
    const padding = (boundary - (currentPos % boundary)) % boundary;
    for (let i = 0; i < padding; i++) {
      this.writeUint8(0);
    }
  }

  /** Get current position */
  get position(): number {
    return this.totalSize + this.offset;
  }

  /** Build final buffer */
  build(): ArrayBuffer {
    // Include current chunk
    this.chunks.push(this.currentChunk.subarray(0, this.offset));
    this.totalSize += this.offset;

    // Concatenate all chunks
    const result = new Uint8Array(this.totalSize);
    let pos = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, pos);
      pos += chunk.length;
    }

    return result.buffer;
  }
}

/**
 * Reader for parsing binary buffers
 */
export class BufferReader {
  private view: DataView;
  private bytes: Uint8Array;
  private offset: number = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
  }

  get position(): number {
    return this.offset;
  }

  set position(pos: number) {
    this.offset = pos;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  /**
   * Bounds-check a read of `count` bytes at the current offset BEFORE it
   * happens, and throw a diagnosable domain error instead of letting a
   * truncated/corrupt buffer reach the engine.
   *
   * Without this, e.g. `readBytes(length)` on a truncated buffer silently
   * clamps via `Uint8Array.slice()` (returning fewer bytes than asked), and
   * a caller that then constructs a typed array of the ORIGINALLY requested
   * element count (`readUint32Array` etc.) hits a raw
   * `RangeError: Invalid typed array length` deep in the engine — the exact
   * "range consisting of offset and length are out of bounds" crash shape.
   * `readInstancedShards` (#1238) hand-rolled this same guard at one call
   * site; every `BufferReader` read now gets it for free.
   */
  private ensureAvailable(count: number): void {
    if (count > this.remaining) {
      throw new Error(
        `BufferReader: read past end of buffer (need ${count} bytes at offset ${this.offset}, ` +
        `only ${this.remaining} remain)`,
      );
    }
  }

  readUint8(): number {
    this.ensureAvailable(1);
    return this.bytes[this.offset++];
  }

  readUint16(): number {
    this.ensureAvailable(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readUint32(): number {
    this.ensureAvailable(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readInt32(): number {
    this.ensureAvailable(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readBigUint64(): bigint {
    this.ensureAvailable(8);
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  readFloat32(): number {
    this.ensureAvailable(4);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readFloat64(): number {
    this.ensureAvailable(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  readBytes(length: number): Uint8Array {
    this.ensureAvailable(length);
    const slice = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  readUint8Array(length: number): Uint8Array {
    return this.readBytes(length);
  }

  readUint16Array(length: number): Uint16Array {
    const bytes = this.readBytes(length * 2);
    return new Uint16Array(bytes.buffer, bytes.byteOffset, length);
  }

  readUint32Array(length: number): Uint32Array {
    const bytes = this.readBytes(length * 4);
    return new Uint32Array(bytes.buffer, bytes.byteOffset, length);
  }

  readInt32Array(length: number): Int32Array {
    const bytes = this.readBytes(length * 4);
    return new Int32Array(bytes.buffer, bytes.byteOffset, length);
  }

  readFloat32Array(length: number): Float32Array {
    const bytes = this.readBytes(length * 4);
    return new Float32Array(bytes.buffer, bytes.byteOffset, length);
  }

  readFloat64Array(length: number): Float64Array {
    const bytes = this.readBytes(length * 8);
    return new Float64Array(bytes.buffer, bytes.byteOffset, length);
  }

  readString(): string {
    const length = this.readUint32();
    const bytes = this.readBytes(length);
    const decoder = new TextDecoder();
    return decoder.decode(bytes);
  }

  /** Skip to alignment boundary */
  align(boundary: number): void {
    const padding = (boundary - (this.offset % boundary)) % boundary;
    this.offset += padding;
  }

  /** Skip bytes */
  skip(bytes: number): void {
    this.offset += bytes;
  }
}

type TypedArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;
