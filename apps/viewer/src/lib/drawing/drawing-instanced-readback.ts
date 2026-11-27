/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every instanced occurrence of a model's backed shards for a whole-model
 * consumer (the 2D drawing, #10264), in bounded groups. One shard is read at a
 * time; its occurrences are materialized by the renderer's own upload
 * preparation (`materializeShardOccurrences`), a group of entities at a time,
 * so at most about `groupBytes` of copies exist at once (an entity larger than
 * that alone is one group). Pieces are in the model's frame: place them.
 */

import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';
import { materializeShardOccurrences } from '@ifc-lite/renderer';
import type { ReadOptions } from '@/lib/geometry-backing/backing-reader';
import type { ModelGeometryBacking } from '@/lib/geometry-backing/geometry-backing-registry';

export const DEFAULT_OCCURRENCE_GROUP_BYTES = 16 * 1024 * 1024;

/** Entity groups of one shard, in first-occurrence order, each within `budget` copied bytes. */
export function occurrenceGroups(shard: DecodedInstancedShard, wanted: (id: number) => boolean, budget: number): number[][] {
  const bytes = new Map<number, number>();
  for (const instance of shard.instances) {
    if (!wanted(instance.entityId)) continue;
    const template = shard.templates[instance.templateIndex];
    const copy = template ? template.positions.byteLength + template.normals.byteLength : 0;
    bytes.set(instance.entityId, (bytes.get(instance.entityId) ?? 0) + copy);
  }
  const groups: number[][] = [];
  let group: number[] = [];
  let used = 0;
  for (const [id, size] of bytes) {
    if (group.length > 0 && used + size > budget) {
      groups.push(group);
      group = [];
      used = 0;
    }
    group.push(id);
    used += size;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

export async function* materializeBackedOccurrences(
  backing: ModelGeometryBacking, modelIndex: number, wanted: (id: number) => boolean,
  options: ReadOptions & { groupBytes?: number } = {},
): AsyncGenerator<MeshData[]> {
  const budget = options.groupBytes ?? DEFAULT_OCCURRENCE_GROUP_BYTES;
  let index = 0;
  for await (const shard of backing.reader.instancedShards(options)) {
    const current = index++;
    for (const group of occurrenceGroups(shard, wanted, budget)) {
      options.signal?.throwIfAborted();
      const members = new Set(group);
      const pieces = materializeShardOccurrences(shard, modelIndex, `drawing:${backing.generation}:${current}:`,
        (id) => members.has(id));
      if (pieces.length > 0) yield pieces;
    }
  }
}
