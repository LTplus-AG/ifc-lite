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

it('#10868 an empty lease is fenced and cancellable like any other read', async () => {
  const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
  try {
    const backing = await registry.begin('m');
    await backing.writer.append([fullMesh(1, Uint32Array.from([0, 1, 2]))]);
    await backing.writer.close();
    const aborted = AbortSignal.abort(new Error('cancelled before any chunk'));
    await assert.rejects(backing.reader.leaseChunks([], { signal: aborted }), /cancelled before any chunk/);
    await registry.invalidate('m', 'mesh edit');
    // An id the directory never listed must not read as "no geometry" on a dead generation.
    await assert.rejects(backing.reader.leaseEntity(424242), StaleGeometryGenerationError);
    await assert.rejects(backing.reader.leaseChunks([]), StaleGeometryGenerationError);
  } finally { await registry.close(); }
});

it('#10868 concurrent producers share one copy budget and close waits for accepted appends', async () => {
  const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
  const db = databaseOf(registry);
  const original = db.commit.bind(db);
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  db.commit = async (stores, write) => { await gate; await original(stores, write); };
  const backing = await registry.begin('m', { chunkBytes: 1, queueBytes: 4096 });
  const appends = Array.from({ length: 200 }, (_, i) =>
    backing.writer.append([fullMesh(i + 1, new Uint32Array(3))]));
  const closed = backing.writer.close();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(backing.writer.pendingBytes <= 4096 + 256, `copied ${backing.writer.pendingBytes} bytes`);
    assert.equal(backing.isComplete, false);
    unblock();
    await Promise.all(appends);
    await closed;
    assert.equal(backing.isComplete, true);
    let count = 0;
    for await (const batch of backing.reader.meshes()) count += batch.length;
    assert.equal(count, 200, 'close must not acknowledge a prefix of concurrent appends');
  } finally {
    unblock();
    await Promise.allSettled([...appends, closed]);
    db.commit = original;
    await registry.close();
  }
});

it('#10868 concurrent acknowledgements name the same complete generation', async () => {
  const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
  try {
    const backing = await registry.begin('m');
    await backing.writer.append([fullMesh(1, new Uint32Array(3))]);
    const [first, second] = await Promise.all([backing.acknowledge(), backing.acknowledge()]);
    assert.deepEqual(first, second);
    assert.equal(registry.verify(first), true);
    assert.equal(registry.verify(second), true);
  } finally { await registry.close(); }
});

it('#10868 an append issued after close began is refused, never silently acknowledged', async () => {
  const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
  const db = databaseOf(registry);
  const original = db.commit.bind(db);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  db.commit = async (stores, write) => { await gate; return original(stores, write); };
  try {
    const backing = await registry.begin('m', { chunkBytes: 64, queueBytes: 4096 });
    await backing.writer.append([fullMesh(1, new Uint32Array(3))]);
    const closing = backing.writer.close();
    const late = backing.writer.append([fullMesh(5, new Uint32Array(3))]);
    open();
    await closing;
    await assert.rejects(late, GeometryBackingFailedError);
    assert.equal(backing.isComplete, true);
    const lease = await backing.reader.leaseEntity(5);
    assert.equal(lease.meshes.length, 0, 'the refused mesh was never stored');
    lease.release();
  } finally { db.commit = original; await registry.close(); }
});

it('#10868 empty whole-model iterators are fenced and cancellable', async () => {
  const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
  try {
    const backing = await registry.begin('m');
    await backing.writer.close();
    const aborted = AbortSignal.abort(new Error('cancelled empty read'));
    await assert.rejects(backing.reader.meshes({ signal: aborted }).next(), /cancelled empty read/);
    await assert.rejects(backing.reader.instancedShards({ signal: aborted }).next(), /cancelled empty read/);
    await registry.invalidate('m');
    await assert.rejects(backing.reader.meshes().next(), StaleGeometryGenerationError);
    await assert.rejects(backing.reader.instancedShards().next(), StaleGeometryGenerationError);
  } finally { await registry.close(); }
});

it('#10868 a source aliasing only the appearance fence keeps that identity', async () => {
  const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
  try {
    const backing = await registry.begin('m');
    const mesh = fullMesh(1, new Uint32Array(3));
    const fence = mesh.indices.slice();
    mesh.appearanceSource = { kind: 'canonical-item', indices: fence, sourceIndices: fence };
    await backing.writer.append([mesh]);
    await backing.writer.close();
    const lease = await backing.reader.leaseEntity(1);
    const read = lease.meshes[0].appearanceSource!;
    assert.equal(read.sourceIndices, read.indices, 'fence and source stay one array');
    assert.notEqual(read.indices, lease.meshes[0].indices, 'and stay distinct from the topology');
    lease.release();
  } finally { await registry.close(); }
});

it('#10868 concurrent chunk decodes share one canonical source instance', async () => {
  const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
  try {
    const backing = await registry.begin('m', { chunkBytes: 64, queueBytes: 4096 });
    const shared = Uint32Array.from([0, 1, 2, 2, 1, 0]);
    await backing.writer.append([fullMesh(1, shared), fullMesh(2, shared)]);
    await backing.writer.close();
    assert.ok(backing.directory.chunks.length >= 2);
    // Hold every read until both chunks have fetched, so neither sees the other's cache entry.
    const db = databaseOf(registry);
    const read = db.read.bind(db);
    let finished = 0, both!: () => void;
    const together = new Promise<void>((resolve) => { both = resolve; });
    db.read = async (stores, collect) => {
      const result = await read(stores, collect);
      if (++finished === 2) both();
      await together;
      return result;
    };
    const [a, b] = await Promise.all([backing.reader.leaseChunks([0]), backing.reader.leaseChunks([1])]);
    db.read = read;
    assert.equal(a.meshes[0].appearanceSource!.sourceIndices, b.meshes[0].appearanceSource!.sourceIndices);
    a.release(); b.release();
  } finally { await registry.close(); }
});
