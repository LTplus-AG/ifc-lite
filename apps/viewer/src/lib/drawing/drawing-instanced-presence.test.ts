/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { discardInstancedShards, enqueueInstancedShards, instancedShardGeneration } from '@/store/instancedShardQueue';
import { GeometryUnavailableError } from '@/lib/geometry-backing/geometry-readback';
import { assertInstancedReady } from './drawing-instanced-presence';

describe('drawing instanced presence (#10264)', () => {
  it('r4645106537 legacy single-model mode: shards already drained, then no renderer: refuses instead of drawing flat only', () => {
    enqueueInstancedShards('legacy-drained', [new ArrayBuffer(8)], instancedShardGeneration());
    discardInstancedShards(); // left the queue (drained into a scene that is now gone)
    assert.throws(() => assertInstancedReady({ models: new Map() }, null), GeometryUnavailableError);
  });
});
