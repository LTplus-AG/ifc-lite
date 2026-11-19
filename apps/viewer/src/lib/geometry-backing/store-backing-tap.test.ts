/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStore } from 'zustand/vanilla';
import type { MeshData } from '@ifc-lite/geometry';
import { enqueueInstancedShards, instancedShardGeneration } from '@/store/instancedShardQueue';
import { StoreGeometryBackingTap, type TapState } from './store-backing-tap';

let names = 0;
const database = () => ({ name: `tap-test-${process.pid}-${names++}`, locks: null });

function mesh(expressId: number, z = 0): MeshData {
  return { expressId, positions: Float32Array.from([0, 0, z, 1, 0, z, 0, 1, z]), normals: new Float32Array(9),
    indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] };
}

/** IFNS v1: one template triangle, one occurrence of `entityId`. */
function shardBytes(entityId: number): ArrayBuffer {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0], normals = [0, 0, 1, 0, 0, 1, 0, 0, 1], indices = [0, 1, 2];
  const dataOffset = 32 + 48 + 88;
  const buffer = new ArrayBuffer(dataOffset + (positions.length + normals.length + indices.length) * 4);
  const view = new DataView(buffer);
  [0x4946_4e53, 1, 1, 1, positions.length, normals.length, indices.length, 0].forEach((w, i) => view.setUint32(i * 4, w, true));
  [0, 9, 0, 9, 0, 3].forEach((w, i) => view.setUint32(32 + i * 4, w, true));
  [10, 0, 0].forEach((v, i) => view.setFloat64(32 + 24 + i * 8, v, true));
  view.setUint32(80, 0, true);
  view.setUint32(84, entityId, true);
  [0.5, 0.5, 0.5, 1].forEach((c, i) => view.setFloat32(88 + i * 4, c, true));
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1].forEach((m, i) => view.setFloat32(104 + i * 4, m, true));
  let cursor = dataOffset;
  for (const v of positions) { view.setFloat32(cursor, v, true); cursor += 4; }
  for (const v of normals) { view.setFloat32(cursor, v, true); cursor += 4; }
  for (const v of indices) { view.setUint32(cursor, v, true); cursor += 4; }
  return buffer;
}

function storeWith(models: Record<string, MeshData[]>) {
  return createStore<TapState>(() => ({
    models: new Map(Object.entries(models).map(([id, meshes]) => [id, { geometryResult: { meshes } }])),
    geometryContentVersion: 0,
  }));
}

/** The loader's in-place append: same array, new record object. */
function append(store: ReturnType<typeof storeWith>, modelId: string, meshes: MeshData[]): void {
  store.setState((state) => {
    const models = new Map(state.models);
    const target = models.get(modelId)!.geometryResult!;
    target.meshes.push(...meshes);
    models.set(modelId, { geometryResult: { meshes: target.meshes } });
    return { models };
  });
}

describe('store geometry backing tap (test/debug only)', () => {
  it('starts mid-load, writes only appended suffixes and seals a verifiable generation', async () => {
    const store = storeWith({ a: [mesh(1), mesh(2)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    append(store, 'a', [mesh(3)]);
    append(store, 'a', [mesh(4), mesh(5)]);
    enqueueInstancedShards('a', [shardBytes(77)], instancedShardGeneration());
    const [status] = await tap.seal();
    assert.equal(status.generation, 1, 'appends never regenerate');
    assert.equal(status.meshes, 5);
    assert.equal(status.shards, 1);
    assert.equal(status.complete, true);
    const backing = tap.backing('a')!;
    const ids: number[] = [];
    for await (const batch of backing.reader.meshes()) ids.push(...batch.map((m) => m.expressId));
    assert.deepEqual(ids, [1, 2, 3, 4, 5]);
    const shards = [];
    for await (const shard of backing.reader.instancedShards()) shards.push(shard);
    assert.equal(shards[0].instances[0].entityId, 77);
    assert.equal(tap.registryHandle.verify(await backing.acknowledge()), true);
    await tap.stop();
  });

  it('a recoloured (copied) list regenerates and carries committed shards forward', async () => {
    const store = storeWith({ m1a: [mesh(1)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('m1a', [shardBytes(5)], instancedShardGeneration());
    await tap.whenIdle();
    store.setState((state) => ({ models: new Map([['m1a', { geometryResult: {
      meshes: state.models.get('m1a')!.geometryResult!.meshes.map((m) => ({ ...m, color: [1, 0, 0, 1] as [number, number, number, number] })) } }]]) }));
    const [status] = await tap.seal();
    assert.equal(status.generation, 2);
    assert.equal(status.shards, 1, 'instanced geometry survives a flat-list edit');
    assert.equal(status.complete, true);
    const lease = await tap.backing('m1a')!.reader.leaseEntity(1);
    assert.deepEqual(lease.meshes[0].color, [1, 0, 0, 1], 'readback answers the current colours');
    lease.release();
    await tap.stop();
  });

  it('a content-version bump fails closed for instanced models and fences readers', async () => {
    const store = storeWith({ m2a: [mesh(1)], m2b: [mesh(2)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('m2a', [shardBytes(5)], instancedShardGeneration());
    await tap.whenIdle();
    const before = tap.backing('m2a')!;
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    const status = Object.fromEntries((await tap.seal()).map((s) => [s.modelId, s]));
    assert.equal(before.isCurrent, false);
    await assert.rejects(before.reader.leaseEntity(1), { name: 'StaleGeometryGenerationError' });
    assert.equal(status.m2a.instancedLost, true);
    assert.equal(status.m2a.complete, false, 'moved occurrences cannot be vouched for');
    assert.equal(status.m2b.complete, true, 'a model without instancing regenerates completely');
    await tap.stop();
  });

  it('removing a model deletes its generation', async () => {
    const store = storeWith({ m3a: [mesh(1)], m3b: [mesh(2)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    await tap.seal();
    const removed = tap.backing('m3a')!;
    store.setState((state) => { const models = new Map(state.models); models.delete('m3a'); return { models }; });
    await tap.whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(removed.isCurrent, false);
    assert.deepEqual((await tap.seal()).map((s) => s.modelId), ['m3b']);
    await tap.stop();
  });

  it('a tap started after shards were enqueued fails closed for that model', async () => {
    enqueueInstancedShards('late', [shardBytes(9)], instancedShardGeneration());
    const store = storeWith({ late: [mesh(1)], flat: [mesh(2)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    const status = Object.fromEntries((await tap.seal()).map((s) => [s.modelId, s]));
    assert.equal(status.late.instancedLost, true, 'the missed shard never reached the backing');
    assert.equal(status.late.complete, false);
    assert.equal(status.flat.complete, true);
    await tap.stop();
  });
});
