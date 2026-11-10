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

import { noteInstancedShardModel } from './instancedShardModels.js';

export interface PendingInstancedShard {
  readonly modelId: string;
  readonly bytes: ArrayBuffer;
}

export interface InstancedShardQueueEvent {
  /** `drained`: handed to the renderer (uploaded or skipped). `discarded`: dropped by a session reset. */
  readonly kind: 'enqueued' | 'drained' | 'discarded';
  readonly modelIds: ReadonlySet<string>;
}

type Listener = (event: InstancedShardQueueEvent) => void;

let pending: PendingInstancedShard[] = [];
const listeners = new Set<Listener>();

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

/** Queue `modelId`'s shard bytes for upload, oldest first. The bytes are read, never detached. */
export function enqueueInstancedShards(modelId: string, shards: readonly ArrayBuffer[]): void {
  if (shards.length === 0) return;
  noteInstancedShardModel(modelId);
  for (const bytes of shards) pending.push({ modelId, bytes });
  emit({ kind: 'enqueued', modelIds: new Set([modelId]) });
}

/**
 * Hand every queued shard to `consume` and empty the queue. `consume` returns
 * the shards it could not place yet (owner not known to it); they go back to
 * the front of the queue in order. Listeners hear `drained` for the shards it
 * took, after `consume` returns (or throws), so a consumer that uploads
 * synchronously has finished before anyone treats the model as settled.
 */
export function drainInstancedShards(
  consume: (shards: readonly PendingInstancedShard[]) => readonly PendingInstancedShard[] | void,
): void {
  if (pending.length === 0) return;
  const taken = pending;
  pending = [];
  let deferred: readonly PendingInstancedShard[] = [];
  try {
    deferred = consume(taken) ?? [];
  } finally {
    if (deferred.length > 0) pending = [...deferred, ...pending];
    const kept = new Set(deferred);
    const drained = taken.filter((shard) => !kept.has(shard));
    if (drained.length > 0) emit({ kind: 'drained', modelIds: modelIdsOf(drained) });
  }
}

/**
 * Drop undrained shards: all of them (a session reset or a full model clear,
 * so a rapid switch cannot upload them into the next scene), or one model's
 * (its removal: model ids are reused, so its bytes must not reach whoever
 * takes the id next, nor fall back to another model's index).
 */
export function discardInstancedShards(modelId?: string): void {
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
