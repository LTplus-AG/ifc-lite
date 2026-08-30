/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { decodeInstancedShard } from '@ifc-lite/geometry';
import { BufferReader, BufferWriter } from '../utils/buffer-utils.js';
import { readInstancedShards, writeInstancedShards } from './instanced-shards.js';

// A real IFNS shard at wire version 1, produced by the Rust encoder before
// #2985 added the per-instance item id (the same bytes the geometry package's
// decoder test freezes). This section stores shard bytes VERBATIM and does not
// re-encode them, so this is literally what a cache written by any earlier
// build holds.
const V1_SHARD_HEX =
  '534e464901000000020000000300000018000000180000000800000000000000000000000c000000000000000c00000000000000040000000000000000000000000000000000000000000000000000000c0000000c0000000c0000000c000000040000000400000000000000000000000000000000000000000000000000000000000000e803000000000000cdcc4c3e9a99993e0000803f0000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f00000000e9030000cdcccc3dcdcc4c3e9a99993e0000803f0000803f0000000000000000000080bf000000000000803f000000000000004000000000000000000000803f000000000000000000000000000000000000803f01000000ea030000cdcc4c3ecdcc4c3e9a99993e0000803f0000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f0000803f00000000000000000000004000000000000000000000803f0000803f000000000000803f000000000000803f0000a0400000a0400000a0400000c0400000a0400000a0400000a0400000c0400000a0400000a0400000a0400000c0400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000020000000300000000000000010000000200000003000000';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

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

  // #2985. The IFNS wire version went 1 → 2 and the cache FORMAT_VERSION moved
  // 15 → 16 with it, so no v16 key serves a v15 entry. A v1 shard must still
  // read back regardless: this section stores shard bytes VERBATIM and never
  // re-encodes them, so those bytes outlive any one cache key. That is a claim about a whole path — persisted
  // bytes → this reader → the decoder that draws them — so it is tested across
  // the whole path, not asserted in a comment on either end.
  it('a v1 shard persisted by an earlier build still reads back and decodes (#2985)', () => {
    const v1 = hexToBytes(V1_SHARD_HEX);
    expect(new DataView(v1.buffer).getUint32(4, true)).toBe(1); // it really is v1

    const writer = new BufferWriter();
    writeInstancedShards(writer, [v1.buffer as ArrayBuffer]);
    const [restored] = readInstancedShards(new BufferReader(writer.build()));

    // Verbatim: the section must not have re-encoded or re-versioned anything.
    expect(Array.from(new Uint8Array(restored))).toEqual(Array.from(v1));

    const shard = decodeInstancedShard(new Uint8Array(restored));
    expect(shard.templates).toHaveLength(2);
    expect(shard.instances.map((i) => i.entityId)).toEqual([1000, 1001, 1002]);
    // No item id, because v1 carried none — not a fabricated 0.
    expect(shard.instances.map((i) => i.itemId)).toEqual([undefined, undefined, undefined]);
  });
});
