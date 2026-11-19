/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import { BackingDatabase, CHUNKS, SESSIONS } from './backing-database';
import { GeometryBackingRegistry } from './geometry-backing-registry';
import { GeometryBackingFailedError } from './backing-writer';
import { StaleGeometryGenerationError } from './backing-reader';
import { fullMesh, instancedShard } from './geometry-backing.test-fixtures';

const databaseOf = (registry: GeometryBackingRegistry): BackingDatabase =>
  (registry as unknown as { db: BackingDatabase }).db;
let names = 0;
const uniqueName = () => `backing-races-${process.pid}-${names++}`;

it('#10868 pins a weakly cached canonical source across an asynchronous read and GC', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx',
    '--import', './src/test/vite-module-hooks.mjs', '--input-type=module', '-e',
    "const m = await import('./src/lib/geometry-backing/__fixtures__/canonical-source-gc.ts'); await m.canonicalSourceGcRace();"],
  { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
});

it('#10868 concurrent begins retire the losing generation and close leaves no orphan', async () => {
  const name = uniqueName();
  const registry = await GeometryBackingRegistry.open({ name, locks: null });
  const [first, second] = await Promise.all([registry.begin('m'), registry.begin('m')]);
  try {
    assert.equal(first.isCurrent, false);
    assert.equal(registry.get('m'), second);
    await assert.rejects(first.writer.append([fullMesh(1, new Uint32Array(3))]), GeometryBackingFailedError);
    await assert.rejects(first.reader.leaseEntity(1), StaleGeometryGenerationError);
    await second.writer.append([fullMesh(2, new Uint32Array(3))]);
    await second.acknowledge();
  } finally {
    await registry.close();
  }
  const probe = await BackingDatabase.open({ name, session: registry.session, locks: null });
  try {
    assert.equal(await probe.count(CHUNKS, first.backingId), 0);
    assert.equal(await probe.count(CHUNKS, second.backingId), 0);
    await assert.rejects(registry.begin('m'), /registry is closed/);
  } finally { probe.close(); }
});

it('#10868 a tab publishing after the sweep snapshot keeps its session and acknowledged geometry', async () => {
  const name = uniqueName();
  const held = new Set<string>();
  let onQuery: (() => Promise<void>) | undefined;
  const locks = {
    async request(lock: string, _options: LockOptions, grant: () => Promise<void>) {
      held.add(lock);
      await grant();
      held.delete(lock);
    },
    async query() {
      const snapshot = { held: [...held].map(name => ({ name })), pending: [] };
      const hook = onQuery;
      onQuery = undefined;
      await hook?.();
      return snapshot;
    },
  } as unknown as LockManager;
  let live: GeometryBackingRegistry | undefined;
  onQuery = async () => {
    live = await GeometryBackingRegistry.open({ name, locks });
    const backing = await live.begin('m');
    await backing.writer.append([fullMesh(1, new Uint32Array(3))]);
    await backing.acknowledge();
  };
  const sweeper = await GeometryBackingRegistry.open({ name, locks });
  try {
    assert.ok(live);
    const sessions = await databaseOf(sweeper).read([SESSIONS], tx => {
      const request = tx.objectStore(SESSIONS).getAllKeys();
      return () => request.result;
    });
    assert.ok(sessions.includes(live.session), 'the live page must remain discoverable for later cleanup');
    const backing = live.get('m')!;
    assert.equal(await databaseOf(live).count(CHUNKS, backing.backingId), 1);
    const lease = await backing.reader.leaseEntity(1);
    try { assert.equal(lease.meshes[0].expressId, 1); } finally { lease.release(); }
  } finally {
    await live?.close();
    await sweeper.close();
  }
});

it('#10868 a large single append waits between chunks instead of copying the entire batch', async () => {
  const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
  const db = databaseOf(registry);
  const original = db.commit.bind(db);
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  db.commit = async (stores, write) => { await gate; await original(stores, write); };
  const backing = await registry.begin('m', { chunkBytes: 1024, queueBytes: 4096 });
  const batch = Array.from({ length: 2000 }, (_, i) => fullMesh(i + 1, new Uint32Array(3)));
  let finished = false;
  const append = backing.writer.append(batch).then(() => { finished = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    // These records each contain under 256 bytes of arrays. One last mesh
    // can cross the bound, but the remaining producer batch must stay uncopied.
    assert.ok(backing.writer.pendingBytes <= 4096 + 256, `copied ${backing.writer.pendingBytes} bytes`);
    assert.ok(backing.directory.chunks.length < 10, 'the entire source batch must not already be sealed');
    unblock();
    await append;
    await backing.writer.close();
    let count = 0;
    for await (const meshes of backing.reader.meshes()) count += meshes.length;
    assert.equal(count, batch.length);
  } finally {
    unblock();
    await append;
    db.commit = original;
    await registry.close();
  }
});

it('#10868 snapshots mutable metadata before a delayed backing transaction', async () => {
  const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
  const db = databaseOf(registry);
  const original = db.commit.bind(db);
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  db.commit = async (stores, write) => { await gate; await original(stores, write); };
  try {
    const backing = await registry.begin('m', { chunkBytes: 1 });
    const mesh = fullMesh(1, new Uint32Array(3));
    await backing.writer.append([mesh]);
    mesh.color[0] = 0.9;
    mesh.origin![0] = -100;
    mesh.material!.roughness = 0.123;
    mesh.localBounds!.min[0] = -999;
    unblock();
    await backing.acknowledge();
    const lease = await backing.reader.leaseEntity(1);
    try {
      assert.equal(lease.meshes[0].color[0], 0.1234567890123);
      assert.equal(lease.meshes[0].origin![0], 2_600_000.125);
      assert.equal(lease.meshes[0].material!.roughness, 0.75);
      assert.equal(lease.meshes[0].localBounds!.min[0], 0);
    } finally { lease.release(); }
  } finally {
    unblock();
    db.commit = original;
    await registry.close();
  }
});

it('#10868 rejects non-integer instanced template references before acknowledging a shard', async () => {
  const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
  try {
    for (const templateIndex of [NaN, Infinity, 0.5, -1, 1]) {
      const backing = await registry.begin('m');
      const shard = instancedShard();
      shard.instances[0].templateIndex = templateIndex;
      await assert.rejects(backing.writer.appendInstancedShard(shard), GeometryBackingFailedError);
      assert.equal(backing.isComplete, false);
    }
  } finally { await registry.close(); }
});
