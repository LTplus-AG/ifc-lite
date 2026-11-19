/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-supply bookkeeping for a model whose backed instancing was lost (#10264).
 * A content-version bump may move occurrences, so the backing calls the model's
 * instancing lost. Only a fresh shard set from a NEWER queue generation can
 * carry current transforms, and only the producer's own statement
 * (`completeInstancedShardSupply`), matched shard for shard, proves that set
 * whole. The accepted statement stays tied to its queue generation until a
 * seal acknowledges it: a later full discard (even one that dropped nothing)
 * or a discard of the model's queued shards voids it.
 */

import type { InstancedShardSupply } from '@/store/instancedShardQueue';

export interface ResupplyState {
  instancedLost: boolean;
  /** Queue generation when instancing was lost; only a newer one can re-supply current transforms. */
  lostAtQueueGeneration?: number;
  /** Fresh shards after the loss, per queue generation. */
  resupply?: { generation: number; received: number; broken?: boolean };
  /** Queue generation of an accepted statement, held until a seal acknowledges it. */
  supplied?: number;
}

/** Whether a shard enqueued now may be backed; counts it toward the re-supply when the model is lost. */
export function admitShard(state: ResupplyState, generation: number): boolean {
  if (!state.instancedLost) return true;
  if (state.lostAtQueueGeneration === undefined || generation === state.lostAtQueueGeneration) return false;
  // A second reset mid-supply leaves superseded fresh shards behind: never whole.
  const resupply = (state.resupply ??= { generation, received: 0 });
  if (resupply.generation !== generation) resupply.broken = true;
  return true;
}

/** Accept the model's statement when it matches what was received; the model is then whole again. */
export function acceptStatement(state: ResupplyState, supply: InstancedShardSupply): void {
  if (!state.instancedLost || state.lostAtQueueGeneration === undefined || supply.generation === state.lostAtQueueGeneration) return;
  const resupply = state.resupply ?? { generation: supply.generation, received: 0 };
  if (resupply.broken || resupply.generation !== supply.generation || resupply.received !== supply.count) return;
  state.instancedLost = false;
  state.lostAtQueueGeneration = state.resupply = undefined;
  state.supplied = supply.generation;
}

/** A statement whose queue generation has moved on proves nothing any more. */
export function statementVoided(state: ResupplyState, generation: number): boolean {
  return state.supplied !== undefined && state.supplied !== generation;
}
