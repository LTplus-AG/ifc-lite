/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { InstancedShardSupply } from '@/store/instancedShardQueue';
import { acceptStatement, admitShard, type ResupplyState } from './instanced-resupply';

it('#10888 r4655016564 a shard arriving at an accepted statement\'s supply point voids it: never complete with an uncounted shard', () => {
  const state: ResupplyState = { instancedLost: true, lostAt: { generation: 1, epoch: 0 } };
  const at = { generation: 2, epoch: 0 };
  assert.equal(admitShard(state, at), true, 'a fresh shard after the loss is admitted');
  state.resupply!.received = 1; // the tap counts it once backed
  acceptStatement(state, { generation: 2, epoch: 0, count: 1 } as InstancedShardSupply);
  assert.equal(state.instancedLost, false, 'the statement matches: instancing restored');
  assert.equal(admitShard(state, at), false, 'a second shard at that point is not one the statement covers');
  assert.equal(state.instancedLost, true, 'instancing is lost again until a fresh set is stated whole');
});
