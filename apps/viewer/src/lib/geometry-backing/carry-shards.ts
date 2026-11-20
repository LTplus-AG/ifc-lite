/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Carry a generation's backed instanced shards into its successor (#10264), in
 * backed order, keeping only what the scene drew: a withheld entry (dropped or
 * discarded before upload) is skipped. A withheld entry the source never backed
 * leaves its membership unknown, so the carry fails closed.
 */

import type { PendingInstancedShard } from '@/store/instancedShardQueue';
import type { ModelGeometryBacking } from './geometry-backing-registry';

interface ShardSource { readonly backing?: ModelGeometryBacking; readonly sources: readonly (PendingInstancedShard | null)[] }
interface ShardTarget { readonly backing?: ModelGeometryBacking; shards: number; occurrences: number; sources: (PendingInstancedShard | null)[] }

export async function carryBackedShards(source: ShardSource, next: ShardTarget, withheld?: ReadonlySet<PendingInstancedShard>): Promise<void> {
  let ordinal = -1, found = 0;
  for await (const shard of source.backing!.reader.instancedShards()) {
    const from = source.sources[++ordinal] ?? null;
    if (from && withheld?.has(from)) { found++; continue; }
    next.shards++; next.occurrences += shard.instances.length; next.sources.push(source.sources[ordinal] ?? null);
    await next.backing!.writer.appendInstancedShard(shard);
  }
  if (withheld && found !== withheld.size) throw new Error('A withheld instanced shard was not among the backed ones');
}
