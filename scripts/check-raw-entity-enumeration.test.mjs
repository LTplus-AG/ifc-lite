/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
// The changed-test oracle removes newly added production files. Keep this test
// loadable in that state so a missing detector fails an assertion, not import.
const detector = await import('./lib/raw-entity-enumeration.mjs').catch(() => null);
const scanRawEntityAccess = (...args) => {
  assert.ok(detector, 'raw entity detector must be available');
  return detector.scanRawEntityAccess(...args);
};
const excessRawAccess = (...args) => {
  assert.ok(detector, 'raw entity detector must be available');
  return detector.excessRawAccess(...args);
};
const changedPathBaselines = (...args) => {
  assert.ok(detector, 'raw entity detector must be available');
  return detector.changedPathBaselines(...args);
};

const path = 'packages/mcp/src/tools/example.ts';
const scan = (source) => scanRawEntityAccess(path, source);

test('#5236 raw-access gate finds a new enumerator, including a duplicate in the same function', () => {
  const old = scan('function query(m) { for (const row of m.store.entityIndex.byType) use(row); }');
  const added = scan('function query(m) { for (const row of m.store.entityIndex.byType) use(row); for (const row of m.store.entityIndex.byType) use(row); }');
  assert.equal(old.length, 1);
  assert.equal(excessRawAccess(old, added).length, 1);
});

test('#5236 a renamed file keeps its source budget while a new file starts empty', () => {
  const baselines = changedPathBaselines('R100\told.ts\trenamed.ts\nM\tedited.ts\nA\tnew.ts');
  assert.equal(baselines.get('renamed.ts'), 'old.ts');
  assert.equal(baselines.get('edited.ts'), 'edited.ts');
  assert.equal(baselines.get('new.ts'), null);
});

test('#5236 moving a raw read between callbacks cannot reuse its old budget slot', () => {
  const old = scan('function query(items, store) { return items.map(() => store.entityIndex.byType); }');
  const moved = scan('function query(items, store) { return items.filter(() => store.entityIndex.byType); }');
  assert.equal(excessRawAccess(old, moved).length, 1);
});

test('#5236 same-named owners have separate budget slots', () => {
  const old = scan('function query() { return store.entityIndex.byType; }');
  const moved = scan('function query() { return []; } function query() { return store.entityIndex.byType; }');
  assert.equal(excessRawAccess(old, moved).length, 1);
});

test('#5236 formatted and optional table-count reads reach the AST detector', () => {
  const hits = scan('function count(entities) { return entities\n.count + entities?.count; }');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((hit) => hit.key.split('|')[2]), ['entities.count', 'entities.count']);
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
