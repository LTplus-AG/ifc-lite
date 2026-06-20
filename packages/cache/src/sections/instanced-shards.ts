/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * InstancedShards section (cache v10). GPU-instanced occurrences are rendered from
 * compact IFNS shards that are NOT part of the flat geometry section, so without
 * persisting them a cache reload would silently drop all opaque repeated geometry.
 *
 * Format: a length-prefixed blob array — uint32 shard count, then per shard a uint32
 * byte length followed by the raw IFNS bytes (already a self-contained wire format,
 * so no re-encode is needed). Restored shards are fed back through the renderer's
 * normal `decodeInstancedShard` → `addInstancedShard` path.
 */
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';

export function writeInstancedShards(
  writer: BufferWriter,
  shards: ReadonlyArray<ArrayBuffer>,
): void {
  writer.writeUint32(shards.length);
  for (const shard of shards) {
    const bytes = new Uint8Array(shard);
    writer.writeUint32(bytes.length);
    writer.writeBytes(bytes);
  }
}

export function readInstancedShards(reader: BufferReader): ArrayBuffer[] {
  const count = reader.readUint32();
  const out: ArrayBuffer[] = [];
  for (let i = 0; i < count; i++) {
    const len = reader.readUint32();
    const bytes = reader.readBytes(len);
    // readBytes may return a view into the larger cache buffer; copy out the exact
    // bytes so the shard is a standalone ArrayBuffer the decoder can own/transfer.
    out.push(bytes.slice().buffer as ArrayBuffer);
  }
  return out;
}
