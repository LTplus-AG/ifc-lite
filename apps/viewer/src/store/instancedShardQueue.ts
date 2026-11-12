/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU-instancing (IFNS) shards on their way from a load to the renderer.
 *
 * Deliberately NOT store state. The shards used to ride the viewer store as
 * `pendingInstancedShards`: the loader appended per streamed batch, the
 * Viewport's drain effect uploaded them and cleared the field. That was two
 * store writes per batch, each running the whole subscriber fan-out and
 * re-rendering the Viewport, which selected the field: 264 of a Holter cold
 * load's 462 store updates. Nothing reads the bytes but the drain, so they
 * travel through this queue and React never hears about them.
 *
 * Producers: the streaming loader (primary loads, per batch), the federated
 * finalize (once its express-id offset is known, #1912), and the two cache-hit
 * paths. Consumer: `useInstancedShardDrain`, the renderer's single drain.
 * Placement indexing (`lib/model-placement/spatial-index.ts`) asks whether a
 * model still has shards in flight and is told when they land.
 */

import { perfTally } from '@ifc-lite/load-trace';
import { noteInstancedShardModel } from './instancedShardModels.js';

export interface PendingInstancedShard {
  readonly modelId: string;
  readonly bytes: ArrayBuffer;
}

export interface InstancedShardQueueEvent {
  /** `drained`: handed to the renderer (uploaded or skipped). `discarded`: dropped by a session reset. */
  readonly kind: 'enqueued' | 'drained' | 'discarded';
  readonly modelIds: ReadonlySet<string>;
  /** `enqueued` only: the shards this call queued (their bytes are read, never detached). */
  readonly shards?: readonly PendingInstancedShard[];
}

type Listener = (event: InstancedShardQueueEvent) => void;

let pending: PendingInstancedShard[] = [];
const listeners = new Set<Listener>();
// Bumped by every full discard (session reset, all models cleared). A load
// captures it after its own reset; its shards are refused once it is behind.
let generation = 0;
const drops = { superseded: 0, ownerless: 0 };

/** Shards that were refused or dropped instead of uploaded, by reason. */
export function instancedShardDrops(): Readonly<typeof drops> {
  return { ...drops };
}

/** Count (and report once per call) shards that never reached the renderer. */
export function noteDroppedInstancedShards(reason: keyof typeof drops, count: number, modelIds: Iterable<string>): void {
  if (count === 0) return;
  drops[reason] += count;
  perfTally(`viewer.instancedShardsDropped.${reason}`, count, 'shards');
  console.warn(`[instancedShardQueue] dropped ${count} ${reason} shard(s) for ${[...new Set(modelIds)].join(', ')}`);
}

/** The queue generation a load should capture after its own reset. */
export function instancedShardGeneration(): number {
  return generation;
}

function emit(event: InstancedShardQueueEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error('[instancedShardQueue] listener failed:', error);
    }
  }
}

function modelIdsOf(shards: readonly PendingInstancedShard[]): Set<string> {
  return new Set(shards.map((shard) => shard.modelId));
}

/**
 * Queue `modelId`'s shard bytes for upload, oldest first. The bytes are read,
 * never detached. Every producer passes the `instancedShardGeneration()` it
 * captured when its load began (after its own reset): shards from a load that
 * a reset or full clear has since superseded are refused here, so they cannot
 * sit in the queue holding their buffers. Required, so no producer can skip it.
 */
export function enqueueInstancedShards(modelId: string, shards: readonly ArrayBuffer[], fromGeneration: number): void {
  if (shards.length === 0) return;
  if (fromGeneration !== generation) {
    noteDroppedInstancedShards('superseded', shards.length, [modelId]);
    return;
  }
  noteInstancedShardModel(modelId);
  const added = shards.map((bytes) => ({ modelId, bytes }));
  for (const shard of added) pending.push(shard);
  emit({ kind: 'enqueued', modelIds: new Set([modelId]), shards: added });
}

/** What the consumer did with one shard: `waiting` keeps it queued. */
export type InstancedShardOutcome = 'uploaded' | 'dropped' | 'waiting';

/**
 * Hand every queued shard to `consume`, which settles each one. Uploaded and
 * dropped shards leave the queue; a `waiting` shard, and any shard `consume`
 * did not settle (it returned early or threw), goes back to the front of the
 * queue in its original order, so a failing consumer loses nothing and
 * uploads nothing twice. Listeners hear `drained` only for shards that left,
 * after `consume` finished, so a synchronous upload is done before anyone
 * treats the model as settled. A throw is rethrown after the queue is
 * restored. A full discard during `consume` wins: its shards are not restored.
 */
export function drainInstancedShards(
  consume: (shards: readonly PendingInstancedShard[], settle: (shard: PendingInstancedShard, outcome: InstancedShardOutcome) => void) => void,
): void {
  if (pending.length === 0) return;
  const taken = pending;
  const takenGeneration = generation;
  pending = [];
  const outcomes = new Map<PendingInstancedShard, InstancedShardOutcome>();
  try {
    consume(taken, (shard, outcome) => { outcomes.set(shard, outcome); });
  } finally {
    const gone = (shard: PendingInstancedShard) => outcomes.get(shard) === 'uploaded' || outcomes.get(shard) === 'dropped';
    const left = taken.filter(gone);
    const restored = taken.filter((shard) => !gone(shard));
    if (restored.length > 0 && generation === takenGeneration) pending = [...restored, ...pending];
    if (left.length > 0) emit({ kind: 'drained', modelIds: modelIdsOf(left) });
  }
}

/**
 * Drop undrained shards: all of them (a session reset or a full model clear,
 * so a rapid switch cannot upload them into the next scene), or one model's
 * (its removal: model ids are reused, so its bytes must not reach whoever
 * takes the id next, nor fall back to another model's index).
 */
export function discardInstancedShards(modelId?: string): void {
  if (modelId === undefined) generation++;
  const dropped = modelId === undefined ? pending : pending.filter((shard) => shard.modelId === modelId);
  if (dropped.length === 0) return;
  pending = modelId === undefined ? [] : pending.filter((shard) => shard.modelId !== modelId);
  emit({ kind: 'discarded', modelIds: modelIdsOf(dropped) });
}

export function hasPendingInstancedShards(modelId?: string): boolean {
  return modelId === undefined ? pending.length > 0 : pending.some((shard) => shard.modelId === modelId);
}

export function subscribeInstancedShards(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// The supported observation point for e2e, as the store is for store state:
// the shards are not store state, so a page subscribes here to see each
// enqueue's wire bytes (`event.shards`).
(globalThis as typeof globalThis & { __ifc_lite_instanced_shards__?: { subscribe: typeof subscribeInstancedShards } })
  .__ifc_lite_instanced_shards__ = { subscribe: subscribeInstancedShards };
