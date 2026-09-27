/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Mutation } from '@ifc-lite/mutations';
import { changeOperations } from './change-operations.js';

const edit = (id: string, modelId: string, entityId: number, timestamp: number): Mutation => ({
  id, modelId, entityId, timestamp, type: 'UPDATE_PROPERTY', psetName: 'Pset_Test',
  propName: 'Status', oldValue: 'before', newValue: 'after',
});

test('#5902 shows a property edit and a federated Bulk run as two newest-first operations', () => {
  const property = edit('property', 'A', 12, 1);
  const bulkA = edit('bulk-a', 'A', 13, 2);
  const bulkB = edit('bulk-b', 'B', 44, 3);
  const stacks = new Map([['A', [property, bulkA]], ['B', [bulkB]]]);
  const tags = new Map([['bulk-a', 'bulk-run'], ['bulk-b', 'bulk-run']]);
  const rows = changeOperations(stacks, tags);
  assert.deepEqual(rows.map(row => [row.id, row.mutations.length, row.entities.length, row.isTop]), [
    ['batch:bulk-run', 2, 2, true],
    ['mutation:property', 1, 1, false],
  ]);

  // Reverting the older edit records an inverse at the top of the stack.
  // The undone source and its inverse disappear from the pending-change list;
  // undoing that inverse makes the source visible again.
  const inverse = edit('inverse', 'A', 12, 4);
  const targets = new Map([['inverse', property]]);
  assert.deepEqual(changeOperations(new Map([['A', [property, bulkA, inverse]], ['B', [bulkB]]]), tags, targets)
    .map(row => row.id), ['batch:bulk-run']);
  assert.deepEqual(changeOperations(stacks, tags, targets).map(row => row.id), ['batch:bulk-run', 'mutation:property']);
  // A real UI event can write both steps within one Date.now() millisecond.
  const tied = new Map([['A', [{ ...property, timestamp: 2 }, bulkA]], ['B', [bulkB]]]);
  assert.deepEqual(changeOperations(tied, tags).map(row => row.id), ['batch:bulk-run', 'mutation:property']);
  const georef: Mutation = { id: 'geo', modelId: 'A', entityId: 0, timestamp: 4,
    type: 'UPDATE_ATTRIBUTE', attributeName: 'georef.mapConversion.Eastings', oldValue: 0, newValue: 1 };
  assert.deepEqual(changeOperations(new Map([['A', [georef]]]), new Map())[0].entities, []);
});
