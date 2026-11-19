/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import { BackingDatabase, CHUNKS, SHARDS, SOURCES } from './backing-database';
import { GeometryBackingFailedError } from './backing-writer';
import { StaleGeometryGenerationError } from './backing-reader';
import { GeometryBackingRegistry, type ModelGeometryBacking } from './geometry-backing-registry';
import { describeMesh, fullMesh, instancedShard } from './geometry-backing.test-fixtures';

let names = 0;
const uniqueName = () => `backing-test-${process.pid}-${names++}`;

function plainMesh(expressId: number, triangles: number): MeshData {
  const positions = new Float32Array(triangles * 9).map((_, i) => i * 0.5 + expressId);
  return {
    expressId, positions, normals: new Float32Array(positions.length),
    indices: Uint32Array.from({ length: triangles * 3 }, (_, i) => i), color: [1, 1, 1, 1],
  };
}

async function collect(backing: ModelGeometryBacking): Promise<MeshData[]> {
  const out: MeshData[] = [];
  for await (const batch of backing.reader.meshes()) out.push(...batch);
  return out;
}

/** Access the private database of a registry (test seam only). */
function databaseOf(registry: GeometryBackingRegistry): BackingDatabase {
  return (registry as unknown as { db: BackingDatabase }).db;
}

describe('live geometry backing', () => {
  it('round-trips every mesh field, identity fence, empty corner fence and pooled sources', async () => {
    const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
    const backing = await registry.begin('model-a', { chunkBytes: 64, queueBytes: 4096 });
    const shared = Uint32Array.from([0, 1, 2, 2, 1, 0]);
    const bitmap = { width: 1, height: 1, close() {} } as unknown as ImageBitmap;
    const meshes = [fullMesh(10, shared, bitmap), fullMesh(20, shared, bitmap)];
    await backing.writer.append(meshes);
    await backing.writer.close();
    assert.equal(backing.isComplete, true);
    assert.ok(backing.directory.chunks.length >= 2, 'the two pieces must land in separate chunks');
    const db = databaseOf(registry);
    assert.equal(await db.count(SOURCES, backing.backingId), 1, 'shared canonical source stored once');

    const read = await collect(backing);
    assert.deepEqual(read.map(describeMesh), meshes.map(describeMesh));
    assert.equal(read[0].appearanceSource?.indices, read[0].indices, 'identity fence restored');
    assert.equal(read[0].appearanceSource?.sourceIndices, read[1].appearanceSource?.sourceIndices,
      'pieces of one item share their decoded canonical source');
    assert.equal(read[0].textureBitmap, bitmap);
    // Exact-length storage: no record persisted the 4 KiB arena behind its views.
    assert.equal(read[0].positions.buffer.byteLength, 36);
    await registry.close();
  });

  it('keeps a stale fence stale and an aliasing source a slot', async () => {
    const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
    const backing = await registry.begin('m');
    const mesh = plainMesh(1, 2);
    const staleFence = mesh.indices.slice();
    mesh.appearanceSource = { kind: 'canonical-item', indices: staleFence, sourceIndices: mesh.indices };
    await backing.writer.append([mesh]);
    await backing.writer.close();
    const [read] = await collect(backing);
    assert.notEqual(read.appearanceSource?.indices, read.indices, 'a replaced topology must not pass the fence');
    assert.equal(read.appearanceSource?.sourceIndices, read.indices);
    assert.equal(read.appearanceSource?.cornerIndices, undefined, 'absent mapping stays absent');
    assert.equal(await databaseOf(registry).count(SOURCES, backing.backingId), 0);
    await registry.close();
  });

  it('round-trips instanced templates and every occurrence exactly', async () => {
    const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
    const backing = await registry.begin('inst');
    const shard = instancedShard();
    await backing.writer.appendInstancedShard(shard);
    await backing.writer.close();
    const read = [];
    for await (const record of backing.reader.instancedShards()) read.push(record);
    assert.deepEqual(read, [shard]);
    assert.deepEqual(backing.directory.shardsOf(502), [0]);
    assert.equal(await databaseOf(registry).count(SHARDS, backing.backingId), 1);
    await registry.close();
  });

  it('refuses unknown fields and never reports such a backing complete', async () => {
    const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
    const backing = await registry.begin('m');
    const mesh = Object.assign(plainMesh(1, 1), { futureField: 1 });
    await assert.rejects(backing.writer.append([mesh]), GeometryBackingFailedError);
    await assert.rejects(backing.writer.close(), GeometryBackingFailedError);
    assert.equal(backing.isComplete, false);
    await registry.close();
  });

  it('applies backpressure until the chunk transaction completes', async () => {
    const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
    const db = databaseOf(registry);
    const original = db.commit.bind(db);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    db.commit = async (stores, write) => { await gate; return original(stores, write); };
    const backing = await registry.begin('m', { chunkBytes: 256, queueBytes: 512 });
    let appended = false;
    const append = backing.writer.append([plainMesh(1, 10), plainMesh(2, 10)]).then(() => { appended = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(appended, false, 'producer must wait while the queue is over its bound');
    assert.ok(backing.writer.pendingBytes > 512);
    open();
    await append;
    await backing.writer.close();
    assert.equal(backing.writer.pendingBytes, 0);
    assert.equal(backing.isComplete, true);
    await registry.close();
  });

  it('a quota abort fails the backing terminally without retrying the commit', async () => {
    const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
    const db = databaseOf(registry);
    const original = db.commit.bind(db);
    let commits = 0;
    db.commit = async () => {
      commits++;
      throw new DOMException('quota', 'QuotaExceededError');
    };
    const backing = await registry.begin('m', { chunkBytes: 64, queueBytes: 64 });
    await assert.rejects(backing.writer.append([plainMesh(1, 4)]), (error: unknown) =>
      error instanceof GeometryBackingFailedError && (error.cause as DOMException).name === 'QuotaExceededError');
    await assert.rejects(backing.writer.append([plainMesh(2, 1)]), GeometryBackingFailedError);
    await assert.rejects(backing.reader.leaseEntity(1), GeometryBackingFailedError);
    assert.equal(commits, 1, 'a failed commit is never replayed');
    assert.equal(backing.isComplete, false);
    assert.equal(backing.directory.chunks[0].state, 'failed');
    db.commit = original;
    await registry.close();
  });

  it('reopens once after the connection closed underneath it', async () => {
    const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
    const backing = await registry.begin('m');
    (databaseOf(registry) as unknown as { connection: IDBDatabase }).connection.close();
    await backing.writer.append([plainMesh(1, 2)]);
    await backing.writer.close();
    assert.equal((await collect(backing)).length, 1);
    await registry.close();
  });

  it('bounds decoded retention by bytes and keeps a leased chunk until released', async () => {
    const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
    const backing = await registry.begin('m', { chunkBytes: 1000, queueBytes: 4096, decodedCacheBytes: 1500 });
    await backing.writer.append(Array.from({ length: 6 }, (_, i) => plainMesh(i + 1, 12)));
    await backing.writer.close();
    assert.equal(backing.directory.chunks.length, 6);
    for await (const batch of backing.reader.meshes()) {
      assert.equal(batch.length, 1);
      assert.ok(backing.reader.retainedBytes <= 1500 + 1024, 'one leased chunk beyond the budget at most');
    }
    assert.ok(backing.reader.retainedBytes <= 1500);
    const big = await backing.reader.leaseChunks([0, 1, 2]);
    assert.ok(backing.reader.retainedBytes > 1500, 'a lease may exceed the budget transiently');
    big.release();
    big.release();
    assert.ok(backing.reader.retainedBytes <= 1500);
    await registry.close();
  });

  it('cancels reads and releases what was acquired', async () => {
    const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
    const backing = await registry.begin('m', { chunkBytes: 64, queueBytes: 4096 });
    await backing.writer.append([plainMesh(1, 4), plainMesh(2, 4)]);
    await backing.writer.close();
    const controller = new AbortController();
    const iterator = backing.reader.meshes({ signal: controller.signal });
    assert.equal((await iterator.next()).done, false);
    controller.abort(new Error('user cancelled'));
    await assert.rejects(iterator.next(), /user cancelled/);
    const lease = await backing.reader.leaseChunks([0, 1]);
    lease.release();
    backing.reader.clear();
    assert.equal(backing.reader.retainedBytes, 0, 'no lease survived the cancelled iterator');
    await registry.close();
  });

  it('fences stale generations on replacement and deletes their records', async () => {
    const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
    const first = await registry.begin('m');
    await first.writer.append([plainMesh(1, 2)]);
    await first.writer.close();
    const db = databaseOf(registry);
    assert.equal(await db.count(CHUNKS, first.backingId), 1);
    const iterator = first.reader.meshes();
    const second = await registry.begin('m');
    await assert.rejects(iterator.next(), StaleGeometryGenerationError);
    await assert.rejects(first.reader.leaseEntity(1), StaleGeometryGenerationError);
    assert.equal(first.isComplete, false);
    assert.equal(await db.count(CHUNKS, first.backingId), 0);
    assert.equal(second.generation, first.generation + 1);
    await second.writer.append([plainMesh(1, 3)]);
    await second.writer.close();
    assert.equal((await collect(second))[0].indices.length, 9);
    await registry.close();
  });

  it('keeps federated models independent', async () => {
    const registry = await GeometryBackingRegistry.open({ name: uniqueName(), locks: null });
    const a = await registry.begin('a');
    const b = await registry.begin('b');
    await a.writer.append([plainMesh(1, 1)]);
    await b.writer.append([plainMesh(1, 2)]);
    await Promise.all([a.writer.close(), b.writer.close()]);
    const ackA = await a.acknowledge();
    const ackB = await b.acknowledge();
    assert.equal(registry.verify(ackA), true);
    await registry.invalidate('a', 'mesh edit');
    assert.equal(registry.verify(ackA), false, 'an invalidated generation no longer acknowledges release');
    assert.equal(registry.verify(ackB), true, 'another federated model is unaffected');
    const replaced = await registry.begin('a');
    assert.equal(registry.verify({ ...ackA, generation: replaced.generation }), false, 'a forged generation fails');
    assert.equal(a.isComplete, false);
    assert.equal(b.isComplete, true);
    const lease = await b.reader.leaseEntity(1);
    assert.equal(lease.meshes[0].indices.length, 6);
    lease.release();
    assert.deepEqual(b.directory.summary(1), {
      meshes: 1, triangles: 2, vertices: 6, bounds: { min: [1, 1.5, 2], max: [8.5, 9, 9.5] },
    });
    await registry.close();
  });

  it('sweeps sessions whose page lock is gone and spares live ones', async () => {
    const name = uniqueName();
    const held = new Set<string>();
    const locks = {
      async request(lock: string, _options: LockOptions, grant: () => Promise<void>) {
        held.add(lock);
        await grant();
        held.delete(lock);
      },
      async query() { return { held: [...held].map((lock) => ({ name: lock })), pending: [] }; },
    } as unknown as LockManager;
    const dead = await GeometryBackingRegistry.open({ name, locks });
    const live = await GeometryBackingRegistry.open({ name, locks });
    for (const registry of [dead, live]) {
      const backing = await registry.begin('m');
      await backing.writer.append([plainMesh(1, 1)]);
      await backing.writer.close();
    }
    const deadDb = databaseOf(dead);
    // A crashed page: its lock is gone, its records remain.
    deadDb.close();
    const third = await GeometryBackingRegistry.open({ name, locks });
    const probe = databaseOf(third);
    const remaining = await probe.read(['sessions'], (tx) => {
      const request = tx.objectStore('sessions').getAllKeys();
      return () => request.result;
    });
    assert.deepEqual(new Set(remaining), new Set([live.session, third.session]));
    const deadChunks = await probe.read([CHUNKS], (tx) => {
      const request = tx.objectStore(CHUNKS).count(BackingDatabase.prefixRange([dead.session]));
      return () => request.result;
    });
    assert.equal(deadChunks, 0, 'a crashed page leaves no geometry behind');
    assert.equal(await databaseOf(live).count(CHUNKS, live.get('m')!.backingId), 1);
    await live.close();
    await third.close();
  });
});
