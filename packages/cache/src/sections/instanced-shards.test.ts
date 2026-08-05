/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { BufferReader, BufferWriter } from '../utils/buffer-utils.js';
import { readInstancedShards, writeInstancedShards } from './instanced-shards.js';

describe('readInstancedShards', () => {
  it('round-trips shards through write/read', () => {
    const shardA = new Uint8Array([1, 2, 3, 4]).buffer;
    const shardB = new Uint8Array([5, 6]).buffer;
    const writer = new BufferWriter();
    writeInstancedShards(writer, [shardA, shardB]);
    const reader = new BufferReader(writer.build());
    const out = readInstancedShards(reader);
    expect(out.length).toBe(2);
    expect(Array.from(new Uint8Array(out[0]))).toEqual([1, 2, 3, 4]);
    expect(Array.from(new Uint8Array(out[1]))).toEqual([5, 6]);
  });

  it('throws the specific "missing length" error when the buffer is truncated to exactly 3 bytes before a shard length prefix (#1238 boundary)', () => {
    // Build a valid section (count=1, one 4-byte shard) then cut the buffer
    // 1 byte short of the length prefix: 4 bytes for the count, plus exactly
    // 3 of the 4 length-prefix bytes, and nothing else. This is the precise
    // boundary the guard exists for: `remaining < 4` must catch it before
    // readUint32() is ever called on an incomplete length field. A guard of
    // `remaining < 3` would let this case fall through to readUint32(),
    // which throws an unrelated RangeError instead of the intended,
    // diagnosable "Truncated InstancedShards" error.
    const shard = new Uint8Array([9, 9, 9, 9]).buffer;
    const writer = new BufferWriter();
    writeInstancedShards(writer, [shard]);
    const full = new Uint8Array(writer.build());

    // full layout: [count:4][len:4][shard bytes:4] = 12 bytes total.
    expect(full.length).toBe(12);
    const truncated = full.slice(0, 4 + 3); // count intact, length prefix cut to 3 bytes
    expect(truncated.length).toBe(7);

    const reader = new BufferReader(truncated.buffer);
    expect(() => readInstancedShards(reader)).toThrow(
      'Truncated InstancedShards: missing length for shard 0/1',
    );
  });
});
