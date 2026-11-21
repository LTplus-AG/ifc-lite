/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import { appendMembers } from './store-backing-tap-model';

it('#10888 r4655067160 a suffix of 300,000 resident meshes is recorded without spreading it into one call', () => {
  const mesh = { expressId: 1 } as MeshData;
  const members: MeshData[] = [mesh];
  const slice = new Array<MeshData>(300_000).fill(mesh); // `members.push(...slice)` throws RangeError here
  assert.doesNotThrow(() => appendMembers(members, slice));
  assert.equal(members.length, 300_001);
  assert.equal(members[300_000], mesh, 'every reference kept, in order');
});
