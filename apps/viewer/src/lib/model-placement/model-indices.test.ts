/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createModelIndexAllocator } from './model-indices.js';

const models = (...ids: string[]) => new Map(ids.map(id => [id, {}]));

it('a reserved slot survives calls before registration and becomes the registered index (#8565)', () => {
  const indices = createModelIndexAllocator();
  assert.deepEqual([...indices(models('ifc'))], [['ifc', 0]]);
  const slot = indices.reserve('capture', models('ifc'));
  assert.equal(slot.index, 1);
  assert.deepEqual([...indices(models('ifc'))], [['ifc', 0]], 'an unregistered reservation is not listed');
  assert.equal(indices(models('ifc', 'other')).get('other'), 2, 'a newcomer never takes the held slot');
  assert.deepEqual([...indices(models('ifc', 'other', 'capture'))], [['ifc', 0], ['capture', 1], ['other', 2]]);
  slot.release();
  slot.release();
  assert.equal(indices(models('ifc', 'other', 'capture')).get('capture'), 1, 'publication keeps the index after release');
});

it('a released unpublished slot is freed; while held it blocks the empty-scene reset (#8565)', () => {
  const indices = createModelIndexAllocator();
  const slot = indices.reserve('capture', models());
  assert.equal(slot.index, 0);
  assert.equal(indices(models()).size, 0);
  assert.equal(indices(models('ifc')).get('ifc'), 1, 'index 0 stays with the outstanding upload');
  assert.equal(indices(models()).size, 0);
  slot.release();
  assert.equal(indices(models()).size, 0);
  assert.equal(indices(models('fresh')).get('fresh'), 0, 'with nothing held the empty scene resets');
});

it('nested reservations of one id need every release (#8565)', () => {
  const indices = createModelIndexAllocator();
  const first = indices.reserve('capture', models());
  const second = indices.reserve('capture', models());
  assert.equal(second.index, first.index);
  first.release();
  assert.equal(indices(models('other')).get('other'), 1, 'still held by the second reservation');
  second.release();
  indices(models());
  assert.equal(indices(models('fresh')).get('fresh'), 0);
});

it('without reservations the shared map keeps its identity until an assignment changes (#7021)', () => {
  const indices = createModelIndexAllocator();
  const first = indices(models('a', 'b'));
  assert.equal(indices(models('a', 'b')), first);
  const removed = indices(models('b'));
  assert.notEqual(removed, first);
  assert.deepEqual([...removed], [['b', 1]], 'indices never compact in a live federation');
  assert.equal(indices(models('b')), removed);
});
