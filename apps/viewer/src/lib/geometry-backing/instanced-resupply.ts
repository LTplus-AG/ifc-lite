/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-supply bookkeeping for a model whose backed instancing was lost (#10264).
 * A content-version bump may move occurrences, so the backing calls the model's
 * instancing lost. Only a fresh shard set from a NEWER queue generation can
 * carry current transforms, and only the producer's own statement
 * (`completeInstancedShardSupply`), matched shard for shard, proves that set
 * whole. The accepted statement stays tied to its supply point until a seal
 * acknowledges it: a later full discard (even one that dropped nothing), or a
 * drop or discard of the model's queued shards, voids it. A model-scoped drop
 * or discard moves only that model's epoch, so the model can be re-supplied
 * within the same queue generation.
 */

import { type InstancedShardSupply, instancedShardGeneration, instancedShardModelEpoch } from '@/store/instancedShardQueue';

/**
 * A point in a model's shard supply: the queue generation (moved by a full reset) and the
 * model's own epoch within it (moved when its queued shards are dropped or discarded).
 */
export interface SupplyPoint { generation: number; epoch: number }

/** Strictly after `point`: a later generation, or a later epoch of the same one. */
export function after(at: SupplyPoint, point: SupplyPoint): boolean {
  return at.generation > point.generation || (at.generation === point.generation && at.epoch > point.epoch);
}
/** Where a model's shard supply stands now. */
export const supplyPoint = (modelId: string): SupplyPoint => ({ generation: instancedShardGeneration(), epoch: instancedShardModelEpoch(modelId) });
const same = (a: SupplyPoint, b: SupplyPoint) => a.generation === b.generation && a.epoch === b.epoch;

export interface ResupplyState {
  instancedLost: boolean;
  /** Where instancing was lost; only shards supplied strictly after it can carry current transforms. */
  lostAt?: SupplyPoint;
  /** Fresh shards after the loss, for one supply point. */
  resupply?: SupplyPoint & { received: number; broken?: boolean };
  /** Supply point of an accepted statement, held until a seal acknowledges it. */
  supplied?: SupplyPoint;
}

/** Whether a shard enqueued now (at `at`) may be backed; counts it toward the re-supply when the model is lost. */
export function admitShard(state: ResupplyState, at: SupplyPoint): boolean {
  if (!state.instancedLost) {
    // A shard at an accepted statement's own supply point is one the statement did not count: void it (r4655016564).
    if (!state.supplied || !same(state.supplied, at)) return true;
    state.instancedLost = true; state.lostAt = at; state.supplied = undefined;
    return false;
  }
  if (!state.lostAt || !after(at, state.lostAt)) return false;
  // A second reset or drop mid-supply leaves superseded fresh shards behind: never whole.
  const resupply = (state.resupply ??= { ...at, received: 0 });
  if (!same(resupply, at)) resupply.broken = true;
  return true;
}

/** Accept the model's statement when it matches, shard for shard, what was received at its supply point. */
export function acceptStatement(state: ResupplyState, supply: InstancedShardSupply): void {
  if (!state.instancedLost || !state.lostAt || !after(supply, state.lostAt)) return;
  const resupply = state.resupply ?? { generation: supply.generation, epoch: supply.epoch, received: 0 };
  if (resupply.broken || !same(resupply, supply) || resupply.received !== supply.count) return;
  state.instancedLost = false;
  state.lostAt = state.resupply = undefined;
  state.supplied = { generation: supply.generation, epoch: supply.epoch };
}

/**
 * A statement whose supply point has moved on proves nothing: a full reset (even one that dropped
 * nothing) moves the generation, a discard of the model (even of an empty queue) moves its epoch.
 */
export function statementVoided(state: ResupplyState, now: SupplyPoint): boolean {
  return state.supplied !== undefined && (state.supplied.generation !== now.generation || state.supplied.epoch !== now.epoch);
}
