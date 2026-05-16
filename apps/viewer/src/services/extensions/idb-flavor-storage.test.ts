/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// fake-indexeddb installs a Node-compatible IDB implementation on
// `globalThis.indexedDB` when imported via the `/auto` entry point.
import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { Flavor } from '@ifc-lite/extensions';
import { IdbFlavorStorage } from './idb-flavor-storage.js';

function baseFlavor(id: string, name: string = id): Flavor {
  return {
    schemaVersion: 1,
    id,
    name,
    description: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    extensions: [],
    lenses: [],
    savedQueries: [],
    keybindings: [],
    layout: { state: {} },
    settings: {},
  };
}

async function resetDb(): Promise<void> {
  // Open + clear the storage between tests so each runs against a
  // clean slate. fake-indexeddb persists in-memory across imports
  // within a single process; clear() wipes the three stores.
  const store = new IdbFlavorStorage();
  await store.clear();
}

describe('IdbFlavorStorage', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('round-trips a flavor through put/get/list/delete', async () => {
    const store = new IdbFlavorStorage();
    const flv = baseFlavor('flv.a', 'A');
    await store.putFlavor(flv);

    const got = await store.getFlavor('flv.a');
    assert.ok(got);
    assert.strictEqual(got.id, 'flv.a');
    assert.strictEqual(got.name, 'A');

    const list = await store.listFlavors();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'flv.a');

    await store.deleteFlavor('flv.a');
    assert.strictEqual(await store.getFlavor('flv.a'), undefined);
    assert.strictEqual((await store.listFlavors()).length, 0);
  });

  it('returns undefined for unknown flavor', async () => {
    const store = new IdbFlavorStorage();
    assert.strictEqual(await store.getFlavor('flv.missing'), undefined);
  });

  it('stores and reads the active-flavor pointer', async () => {
    const store = new IdbFlavorStorage();
    assert.strictEqual(await store.getActiveId(), undefined);
    await store.setActiveId('flv.a');
    assert.strictEqual(await store.getActiveId(), 'flv.a');
    await store.setActiveId(undefined);
    assert.strictEqual(await store.getActiveId(), undefined);
  });

  it('clears the active pointer when the active flavor is deleted', async () => {
    const store = new IdbFlavorStorage();
    await store.putFlavor(baseFlavor('flv.a'));
    await store.setActiveId('flv.a');
    await store.deleteFlavor('flv.a');
    assert.strictEqual(await store.getActiveId(), undefined);
  });

  it('captures a snapshot when overwriting a flavor', async () => {
    const store = new IdbFlavorStorage();
    await store.putFlavor(baseFlavor('flv.a', 'first'));
    await store.putFlavor(baseFlavor('flv.a', 'second'), 'rename');
    const snaps = await store.listSnapshots('flv.a');
    assert.strictEqual(snaps.length, 1);
    assert.strictEqual(snaps[0].flavor.name, 'first');
    assert.strictEqual(snaps[0].reason, 'rename');
  });

  it('caps snapshot retention at 10 per flavor', async () => {
    const store = new IdbFlavorStorage();
    for (let i = 0; i < 15; i++) {
      await store.putFlavor(baseFlavor('flv.a', `v${i}`));
    }
    const snaps = await store.listSnapshots('flv.a');
    assert.ok(snaps.length <= 10, `expected ≤10 snapshots, got ${snaps.length}`);
    // Newest first.
    assert.strictEqual(snaps[0].flavor.name, 'v13');
  });

  it('restoreSnapshot writes the snapshot back as the current flavor', async () => {
    const store = new IdbFlavorStorage();
    await store.putFlavor(baseFlavor('flv.a', 'v1'));
    await store.putFlavor(baseFlavor('flv.a', 'v2'));
    const snaps = await store.listSnapshots('flv.a');
    assert.strictEqual(snaps[0].flavor.name, 'v1');
    const restored = await store.restoreSnapshot('flv.a', snaps[0].seq, 'rollback');
    assert.ok(restored);
    const current = await store.getFlavor('flv.a');
    assert.strictEqual(current?.name, 'v1');
  });

  it('cascade-deletes snapshots when a flavor is deleted', async () => {
    const store = new IdbFlavorStorage();
    await store.putFlavor(baseFlavor('flv.a', 'v1'));
    await store.putFlavor(baseFlavor('flv.a', 'v2'));
    await store.deleteFlavor('flv.a');
    const snaps = await store.listSnapshots('flv.a');
    assert.strictEqual(snaps.length, 0);
  });

  it('listSnapshots scopes by flavor id', async () => {
    const store = new IdbFlavorStorage();
    await store.putFlavor(baseFlavor('flv.a', 'a1'));
    await store.putFlavor(baseFlavor('flv.a', 'a2'));
    await store.putFlavor(baseFlavor('flv.b', 'b1'));
    await store.putFlavor(baseFlavor('flv.b', 'b2'));
    const a = await store.listSnapshots('flv.a');
    const b = await store.listSnapshots('flv.b');
    assert.strictEqual(a.length, 1);
    assert.strictEqual(b.length, 1);
    assert.strictEqual(a[0].flavor.name, 'a1');
    assert.strictEqual(b[0].flavor.name, 'b1');
  });
});
