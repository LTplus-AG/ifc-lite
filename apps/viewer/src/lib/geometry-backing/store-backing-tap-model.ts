/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The backing tap's per-model state and its status rows (#10264), kept apart from the tap's ingestion logic. */

import type { MeshData } from '@ifc-lite/geometry';
import type { PendingInstancedShard } from '@/store/instancedShardQueue';
import type { MeshAreas } from './released-mesh-areas';
import type { ResupplyState } from './instanced-resupply';
import type { ModelGeometryBacking } from './geometry-backing-registry';

/** The store fields the tap reads. */
export interface TapState {
  models: ReadonlyMap<string, { geometryResult: { meshes: MeshData[] } | null; idOffset?: number }>;
  geometryContentVersion: number;
}

export interface Tracked extends ResupplyState {
  /** Registry key of this generation: generations stage side by side. */
  key: string;
  backing?: ModelGeometryBacking;
  /** Per-model generation number (1 for a model's first generation). */
  number: number;
  /** Generations kept until this one is acknowledged complete and current. */
  retained: string[];
  meshes: MeshData[] | undefined;
  /** Immutable snapshot of the store meshes this generation holds, in record order. The store
   * array itself may be spliced in place later; replay must not read membership from it. */
  members: MeshData[];
  consumed: number;
  chain: Promise<void>;
  failure?: Error;
  shards: number;
  sources: (PendingInstancedShard | null)[]; // the queue entry each backed shard came from, in backed order
  /** Instanced occurrences backed; empty shard records are not instancing. */
  occurrences: number;
  /** The store list changed after a CPU release: this generation is kept durable but no longer answers. */
  stale?: Error;
  areas: MeshAreas; // per-entity mesh area of this generation, summed as one pass over the whole list would
  flatSealed?: boolean; // instancing lost, every flat record flushed by a seal and nothing written since (`flatComplete`)
  /** Replaced (or removed) before its generation began: superseded as soon as it does (#10876). */
  replaced?: boolean;
  /** A carry of the predecessor's shards is still pending: they count as this generation's shards (#10876). */
  carrying?: boolean;
  /** The store has listed this model: only then can its absence mean a removal (a shard may arrive first, #10876). */
  registered?: boolean;
  /** A seal is closing and acknowledging this generation: its writer takes no more appends (r4647508608). */
  sealing?: boolean;
}

export interface ModelBackingStatus {
  modelId: string;
  generation: number;
  meshes: number;
  chunks: number;
  shards: number;
  storedBytes: number;
  pendingBytes: number;
  complete: boolean;
  instancedLost: boolean;
  error?: string;
}

/** One model's status row; `missedShards`: shards were enqueued before the tap started. */
export function backingStatusRow(modelId: string, tracked: Tracked, missedShards: boolean): ModelBackingStatus {
  const backing = tracked.backing;
  const instancedLost = tracked.instancedLost || missedShards;
  const error = tracked.stale ?? tracked.failure ?? backing?.writer.error;
  return {
    modelId, generation: tracked.number, meshes: tracked.consumed,
    chunks: backing?.directory.chunks.length ?? 0, shards: backing?.directory.shards.length ?? 0,
    storedBytes: backing?.directory.storedBytes ?? 0, pendingBytes: backing?.writer.pendingBytes ?? 0,
    complete: !!backing?.isComplete && !instancedLost && !tracked.failure && !tracked.stale && tracked.meshes !== undefined,
    instancedLost, ...(error ? { error: `${error.name}: ${error.message}` } : {}),
  };
}

/** Instancing lost but every flat record durable: flat-only readback may answer (`flatComplete`). */
export function flatRecordsComplete(tracked: Tracked | undefined): boolean {
  const b = tracked?.backing;
  return !!tracked?.flatSealed && !!b && !tracked.failure && !tracked.stale && b.isCurrent && !b.writer.error && !b.writer.hasUnsealed
    && b.writer.pendingBytes === 0 && b.directory.chunks.every((c) => c.state === 'durable');
}
