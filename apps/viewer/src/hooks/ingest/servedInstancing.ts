/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One server load's GPU-instanced shards: the shapes the server sent once, as
 * IFNS shards on the same queue a local parse feeds (`instancedShardQueue`).
 *
 * The loader asks the client for `sharedShapes`, so each batch arrives as flat
 * meshes plus shared shapes. This collects the shapes' shards, grows the
 * model bounds by their occurrences, and keeps each instanced-only entity's
 * box for `GeometryResult.instancedGeometryAabbs`.
 *
 * Shards are queued only once the load owns the model slot ({@link begin},
 * called after the load's first publication, which is when an upload resets
 * the viewer): a shard queued before that reset would be refused as stale, or
 * worse, drawn into the scene the reset is about to clear. They stay in
 * {@link shards} either way, for a caller that registers the model later.
 */

import type { EntityWorldAabb } from '@ifc-lite/geometry';
import type { MeshData as ServerMeshData, SharedShape } from '@ifc-lite/server-client';
import {
  completeInstancedShardSupply,
  enqueueInstancedShards,
  instancedShardSupplyToken,
  type InstancedShardSupplyToken,
} from '@/store/instancedShardQueue';
import type { Bounds3D } from '../../utils/localParsingUtils.js';
import { encodeSharedShapeShard, growBySharedShapes, instancedOnlyAabbs, sharedShapeCounts, SharedShapeRouting } from '../../utils/serverInstancing.js';

export class ServedInstancing {
  /** Every shard this load produced, in order. */
  readonly shards: ArrayBuffer[] = [];
  /** Instanced occurrences, and the vertices and triangles they draw. */
  occurrences = 0;
  vertices = 0;
  triangles = 0;
  private readonly boxes = new Map<number, EntityWorldAabb>();
  private readonly routing = new SharedShapeRouting();
  private token: InstancedShardSupplyToken | null = null;
  private queued = 0;

  constructor(private readonly modelId: string) {}

  /**
   * Take one batch's (or one blob's) shared shapes: the occurrences the local
   * partition's rule would instance grow `bounds` and become a shard, queued if
   * begun; the rest come back as flat meshes for the caller to draw as before.
   */
  add(shapes: readonly SharedShape[] | undefined, bounds: Bounds3D): ServerMeshData[] {
    const { instanced, flat } = this.routing.split(shapes);
    if (instanced.length === 0) return flat;
    growBySharedShapes(bounds, instanced, this.boxes);
    const counts = sharedShapeCounts(instanced);
    this.occurrences += counts.occurrences;
    this.vertices += counts.vertices;
    this.triangles += counts.triangles;
    const shard = encodeSharedShapeShard(instanced);
    if (shard) this.shards.push(shard);
    this.flush();
    return flat;
  }

  /** The load now owns the model slot: capture its shard supply and queue what has arrived. */
  begin(): void {
    if (this.token) return;
    this.token = instancedShardSupplyToken(this.modelId);
    this.flush();
  }

  /** Every shard is queued: state the supply complete (zero included). */
  complete(): void {
    this.begin();
    completeInstancedShardSupply(this.modelId, this.shards.length, this.token!);
  }

  /** Instanced-only entity boxes in absolute world (see `instancedOnlyAabbs`). */
  aabbs(flatIds: ReadonlySet<number>, originShift: { x: number; y: number; z: number }): Map<number, EntityWorldAabb> | undefined {
    return instancedOnlyAabbs(this.boxes, flatIds, originShift);
  }

  private flush(): void {
    if (!this.token || this.queued === this.shards.length) return;
    enqueueInstancedShards(this.modelId, this.shards.slice(this.queued), this.token);
    this.queued = this.shards.length;
  }
}
