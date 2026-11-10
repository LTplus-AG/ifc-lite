/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A drain that throws loses nothing, repeats nothing and leaves no stuck
 * queue (#9628 review). The consumer settles each shard; what it had not
 * settled when it threw goes back to the front of the queue in order, and only
 * settled shards are reported drained.
 */
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  discardInstancedShards, drainInstancedShards, enqueueInstancedShards, hasPendingInstancedShards,
  instancedShardGeneration, subscribeInstancedShards, type InstancedShardQueueEvent, type PendingInstancedShard,
} from './instancedShardQueue.js';

afterEach(() => discardInstancedShards());

const bytes = (n: number) => new Uint8Array([n]).buffer;
const value = (shard: PendingInstancedShard) => new Uint8Array(shard.bytes)[0];
function queue(...models: string[]) {
  models.forEach((model, i) => enqueueInstancedShards(model, [bytes(i + 1)], instancedShardGeneration()));
}

it('a consumer that throws mid-drain keeps every unsettled shard queued, in order, and reports only what it settled', () => {
  queue('a', 'b', 'c');
  const events: InstancedShardQueueEvent[] = [];
  const off = subscribeInstancedShards((event) => events.push(event));
  try {
    assert.throws(() => drainInstancedShards((shards, settle) => {
      settle(shards[0], 'uploaded');
      throw new Error('renderer failed after the first upload');
    }), /renderer failed/);
    assert.deepEqual(events.map((e) => [e.kind, [...e.modelIds]]), [['drained', ['a']]], 'only the settled shard is drained');

    const second: number[] = [];
    drainInstancedShards((shards, settle) => {
      for (const shard of shards) { second.push(value(shard)); settle(shard, 'uploaded'); }
    });
    assert.deepEqual(second, [2, 3], 'the unsettled shards come back once, in order; the uploaded one does not repeat');
    assert.equal(hasPendingInstancedShards(), false, 'nothing is stuck once a drain settles everything');
  } finally {
    off();
  }
});

it('a throw before any settlement restores the whole batch ahead of shards enqueued meanwhile', () => {
  queue('a', 'b');
  assert.throws(() => drainInstancedShards(() => {
    enqueueInstancedShards('c', [bytes(9)], instancedShardGeneration()); // a producer reacting mid-drain
    throw new Error('first shard failed');
  }));
  const order: number[] = [];
  drainInstancedShards((shards, settle) => { for (const shard of shards) { order.push(value(shard)); settle(shard, 'uploaded'); } });
  assert.deepEqual(order, [1, 2, 9]);
});

it('waiting and unsettled shards stay queued after a normal return; dropped ones leave', () => {
  queue('a', 'b', 'c');
  drainInstancedShards((shards, settle) => {
    settle(shards[0], 'dropped');
    settle(shards[1], 'waiting');
    // shards[2] is never settled
  });
  const left: number[] = [];
  drainInstancedShards((shards, settle) => { for (const shard of shards) { left.push(value(shard)); settle(shard, 'uploaded'); } });
  assert.deepEqual(left, [2, 3]);
});

it('a full discard during a drain wins over restoring its unsettled shards', () => {
  queue('a', 'b');
  assert.throws(() => drainInstancedShards(() => {
    discardInstancedShards(); // e.g. a session reset fired from inside the consumer
    throw new Error('after reset');
  }));
  assert.equal(hasPendingInstancedShards(), false, 'the superseded batch is not resurrected');
});

it('refuses a producer whose generation a full discard superseded', () => {
  const captured = instancedShardGeneration();
  discardInstancedShards();
  enqueueInstancedShards('a', [bytes(1)], captured);
  assert.equal(hasPendingInstancedShards(), false);
});
