/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { discardInstancedShards, drainInstancedShards, enqueueInstancedShards, instancedShardGeneration } from '@/store/instancedShardQueue';
import { GeometryUnavailableError } from '@/lib/geometry-backing/geometry-readback';
import { assertInstancedReady } from './drawing-instanced-presence';

describe('drawing instanced presence (#10264)', () => {
  it('r4645106537 legacy single-model mode: shards already drained, then no renderer: refuses instead of drawing flat only', () => {
    enqueueInstancedShards('legacy-drained', [new ArrayBuffer(8)], instancedShardGeneration());
    drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'uploaded'); }); // left the queue, into a scene now gone
    assert.throws(() => assertInstancedReady({ models: new Map() }, null), GeometryUnavailableError);
  });

  it('unload: shards of an unloaded legacy model do not refuse a later flat-only legacy drawing', () => {
    enqueueInstancedShards('legacy-unloaded', [new ArrayBuffer(8)], instancedShardGeneration());
    drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'uploaded'); });
    discardInstancedShards(); // the next load's session reset
    assert.doesNotThrow(() => assertInstancedReady({ models: new Map() }, null));
  });
});
