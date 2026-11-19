/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Instanced occurrences read back from a model's backed shards (#10264). The
 * flat store list never held them, so tools and exports over released
 * geometry materialize them here, with the renderer's own upload preparation
 * (`materializeShardOccurrences`), in the model's frame: place them like flat
 * pieces. Materialized meshes are transient copies, bounded by bytes; a read
 * that would exceed the bound fails rather than answering with a subset.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { materializeShardOccurrences } from '@ifc-lite/renderer';
import type { ReadOptions } from './backing-reader';
import type { ModelGeometryBacking } from './geometry-backing-registry';
import { GeometryUnavailableError } from './geometry-readback';

export const DEFAULT_INSTANCED_READ_BYTES = 64 * 1024 * 1024;

const meshBytes = (mesh: MeshData) => mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength;

/** Every opaque occurrence of `entityIds` (global ids) held by this backing's shards. */
export async function readInstancedOccurrences(
  backing: ModelGeometryBacking, entityIds: ReadonlySet<number>, modelIndex: number,
  options: ReadOptions & { budgetBytes?: number } = {},
): Promise<MeshData[]> {
  if (!backing.isCurrent || !backing.isComplete) {
    throw new GeometryUnavailableError(`Model ${backing.modelId}'s geometry backing is not complete and current`);
  }
  const needed = new Set<number>();
  for (const id of entityIds) for (const index of backing.directory.shardsOf(id)) needed.add(index);
  if (needed.size === 0) return [];
  const last = Math.max(...needed);
  const budget = options.budgetBytes ?? DEFAULT_INSTANCED_READ_BYTES;
  const out: MeshData[] = [];
  let bytes = 0;
  let index = 0;
  for await (const shard of backing.reader.instancedShards(options)) {
    const current = index++;
    if (needed.has(current)) {
      for (const mesh of materializeShardOccurrences(shard, modelIndex, `readback:${backing.generation}:${current}:`,
        (id) => entityIds.has(id))) {
        bytes += meshBytes(mesh);
        if (bytes > budget) throw new GeometryUnavailableError(`Instanced readback exceeds its ${budget}-byte bound`);
        out.push(mesh);
      }
    }
    if (current >= last) break;
  }
  return out;
}
