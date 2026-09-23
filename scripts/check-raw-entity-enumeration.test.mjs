/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanRawEntityAccess, excessRawAccess } from './lib/raw-entity-enumeration.mjs';

const path = 'packages/mcp/src/tools/example.ts';
const scan = (source) => scanRawEntityAccess(path, source);

test('#5236 raw-access gate finds a new enumerator, including a duplicate in the same function', () => {
  const old = scan('function query(m) { for (const row of m.store.entityIndex.byType) use(row); }');
  const added = scan('function query(m) { for (const row of m.store.entityIndex.byType) use(row); for (const row of m.store.entityIndex.byType) use(row); }');
  assert.equal(old.length, 1);
  assert.equal(excessRawAccess(old, added).length, 1);
});

test('#5236 moving a raw read between callbacks cannot reuse its old budget slot', () => {
  const old = scan('function query(items, store) { return items.map(() => store.entityIndex.byType); }');
  const moved = scan('function query(items, store) { return items.filter(() => store.entityIndex.byType); }');
  assert.equal(excessRawAccess(old, moved).length, 1);
});

test('#5236 raw-access gate catches table-count loops and byId point reads', () => {
  const hits = scan('function select(entities, store) { for (let i = 0; i < entities.count; i++) use(i); store.entityIndex.byId.get(7); }');
  assert.deepEqual(hits.map((hit) => hit.key.split('|')[2]), ['entities.count', 'entityIndex.byId']);
  assert.equal(excessRawAccess([], hits).length, 2);
});

test('#5236 removal shrinks the raw-access census', () => {
  const old = scan('function query(m) { for (const row of m.store.entityIndex.byType) use(row); }');
  assert.deepEqual(excessRawAccess(old, scan('function query(m) { use(m); }')), []);
});

test('#5236 deliberate raw read needs an adjacent reason', () => {
  const intentional = scan(`function watermark(store) {
  // @raw-entity-enumeration-ok Keep tombstones so express IDs are never reused.
  for (const id of store.entityIndex.byId.keys()) use(id);
}`);
  assert.equal(intentional[0].reason, 'Keep tombstones so express IDs are never reused.');
  assert.deepEqual(excessRawAccess([], intentional), []);
  const unmarked = scan('function watermark(store) { for (const id of store.entityIndex.byId.keys()) use(id); }');
  assert.equal(excessRawAccess([], unmarked).length, 1);
  assert.equal(excessRawAccess(intentional, unmarked).length, 1,
    'an annotated base site cannot lend its slot to a new unmarked read');
});
