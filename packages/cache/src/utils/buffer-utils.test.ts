/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pins `BufferReader`'s bounds guard (issue #2230 hunt): every scalar/array
 * read must fail with a diagnosable `Error` when a truncated or corrupt
 * buffer can't satisfy the requested length, rather than letting a raw
 * engine `RangeError` ("Range consisting of offset and length are out of
 * bounds" / "Invalid typed array length") escape from deep inside a typed
 * array constructor. That raw-engine shape is exactly what happens when
 * `readBytes` clamps via `Uint8Array.slice()` on a short buffer and a caller
 * (e.g. `readUint32Array`) then constructs a typed array at the ORIGINALLY
 * requested element count against the clamped (shorter) result buffer.
 */

import { describe, it, expect } from 'vitest';
import { BufferReader, BufferWriter } from './buffer-utils.js';

describe('BufferReader bounds guard', () => {
  it('readBytes throws a diagnosable error instead of silently clamping on a truncated buffer', () => {
    const reader = new BufferReader(new Uint8Array([1, 2, 3]).buffer);
    expect(() => reader.readBytes(10)).toThrow(/read past end of buffer/);
  });

  it('readUint32Array throws instead of hitting a raw "Invalid typed array length" RangeError', () => {
    // 3 bytes available; asking for 10 uint32s (40 bytes) used to clamp
    // readBytes(40) down to a 3-byte slice, then blow up constructing
    // `new Uint32Array(slice.buffer, slice.byteOffset, 10)` against that
    // 3-byte buffer with a raw engine RangeError.
    const reader = new BufferReader(new Uint8Array([1, 2, 3]).buffer);
    let threw: unknown;
    try {
      reader.readUint32Array(10);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toMatch(/read past end of buffer/);
    // Specifically NOT the raw engine message this bug used to produce.
    expect((threw as Error).message).not.toMatch(/Invalid typed array length/);
  });

  it('readString throws cleanly when the declared length runs past the buffer', () => {
    const writer = new BufferWriter();
    writer.writeUint32(1000); // declared string byte length
    writer.writeBytes(new Uint8Array([104, 105])); // only 2 bytes actually present
    const reader = new BufferReader(writer.build());
    expect(() => reader.readString()).toThrow(/read past end of buffer/);
  });

  it('readUint16/readUint32/readInt32/readBigUint64/readFloat32/readFloat64 all bounds-check', () => {
    const empty = () => new BufferReader(new ArrayBuffer(0));
    expect(() => empty().readUint16()).toThrow(/read past end of buffer/);
    expect(() => empty().readUint32()).toThrow(/read past end of buffer/);
    expect(() => empty().readInt32()).toThrow(/read past end of buffer/);
    expect(() => empty().readBigUint64()).toThrow(/read past end of buffer/);
    expect(() => empty().readFloat32()).toThrow(/read past end of buffer/);
    expect(() => empty().readFloat64()).toThrow(/read past end of buffer/);
  });

  it('reads succeed normally when the buffer has enough bytes', () => {
    const writer = new BufferWriter();
    writer.writeUint32(0xdeadbeef);
    const reader = new BufferReader(writer.build());
    expect(reader.readUint32()).toBe(0xdeadbeef);
  });
});
