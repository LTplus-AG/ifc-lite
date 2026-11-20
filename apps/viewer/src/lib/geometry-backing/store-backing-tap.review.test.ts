/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10876 review classes on the ingestion tap: a replaced or removed generation
 * stops being current at once; a removal's cleanup retires only its own
 * generation and `whenIdle` waits for it; successive flat edits keep a pending
 * shard carry; a list already released when the tap first sees it is never
 * backed as empty records.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createStore } from 'zustand/vanilla';
import type { MeshData } from '@ifc-lite/geometry';
import { enqueueInstancedShards, instancedShardGeneration } from '@/store/instancedShardQueue';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { StoreGeometryBackingTap, type TapState } from './store-backing-tap';

let names = 0;
const database = () => ({ name: `tap-review-${process.pid}-${names++}`, locks: null });
const mesh = (expressId: number, z = 0): MeshData => ({ expressId, positions: Float32Array.from([0, 0, z, 1, 0, z, 0, 1, z]),
  normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] });
const many = (n: number, from = 1) => Array.from({ length: n }, (_, i) => mesh(from + i, i));
const storeWith = (models: Record<string, MeshData[]>) => createStore<TapState>(() => ({
  models: new Map(Object.entries(models).map(([id, meshes]) => [id, { geometryResult: { meshes } }])), geometryContentVersion: 0 }));
const setList = (store: ReturnType<typeof storeWith>, id: string, meshes: MeshData[] | null) => store.setState((s) => {
  const models = new Map(s.models);
  if (meshes) models.set(id, { geometryResult: { meshes } }); else models.delete(id);
  return { models };
});

function shardBytes(entityId: number): ArrayBuffer {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0], normals = [0, 0, 1, 0, 0, 1, 0, 0, 1], indices = [0, 1, 2];
  const dataOffset = 32 + 48 + 88;
  const buffer = new ArrayBuffer(dataOffset + (positions.length + normals.length + indices.length) * 4);
  const view = new DataView(buffer);
  [0x4946_4e53, 1, 1, 1, positions.length, normals.length, indices.length, 0].forEach((w, i) => view.setUint32(i * 4, w, true));
  [0, 9, 0, 9, 0, 3].forEach((w, i) => view.setUint32(32 + i * 4, w, true));
  [10, 0, 0].forEach((v, i) => view.setFloat64(32 + 24 + i * 8, v, true));
  view.setUint32(84, entityId, true);
  [0.5, 0.5, 0.5, 1].forEach((c, i) => view.setFloat32(88 + i * 4, c, true));
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1].forEach((m, i) => view.setFloat32(104 + i * 4, m, true));
  let cursor = dataOffset;
  for (const v of positions) { view.setFloat32(cursor, v, true); cursor += 4; }
  for (const v of normals) { view.setFloat32(cursor, v, true); cursor += 4; }
  for (const v of indices) { view.setUint32(cursor, v, true); cursor += 4; }
  return buffer;
}

it('#10876 a replaced generation is not current from the moment the store replaces it, before its successor begins', async () => {
  const store = storeWith({ rp: [mesh(1)] });
  const tap = await StoreGeometryBackingTap.start(store, { database: database() });
  await tap.seal();
  const old = tap.backing('rp')!;
  assert.equal(old.isCurrent, true);
  setList(store, 'rp', many(600)); // a new list: the successor begins only after the chain moves on
  setList(store, 'rp', many(600, 1000)); // and another, while the first replacement is still pending
  assert.equal(old.isCurrent, false, 'a retained handle reports the replaced geometry as not current at once');
  await assert.rejects(old.reader.leaseEntity(1), /replaced/i, 'and its reader refuses');
  await tap.whenIdle();
  const [status] = await tap.seal();
  assert.equal(status.complete, true, status.error ?? 'incomplete');
  assert.equal(status.meshes, 600, 'the latest list is the current generation');
  await tap.stop();
});

it('#10876 a model removed during a pending append: its handle stops being current at once, whenIdle waits for its cleanup, a re-added model survives', async () => {
  const store = storeWith({ rm: many(600) });
  const tap = await StoreGeometryBackingTap.start(store, { database: database() });
  const removed = tap.backing('rm');
  setList(store, 'rm', null); // removed while its append is still pending
  if (removed) assert.equal(removed.isCurrent, false, 'not current from the removal on');
  setList(store, 'rm', [mesh(7)]); // the same id re-added before the removal's cleanup ran
  await tap.whenIdle();
  const readded = tap.backing('rm');
  assert.ok(readded && readded !== removed, 'the re-added model has its own generation');
  assert.equal(readded.isCurrent, true, "the removal's deferred cleanup never deleted the re-added model's generation");
  const [status] = await tap.seal();
  assert.equal(status.complete, true, status.error ?? 'incomplete');
  assert.equal(status.meshes, 1);
  await tap.stop();
});

it('#10876 two successive flat edits of an instanced model still carry its shards', async () => {
  const store = storeWith({ ce: [mesh(1)] });
  const tap = await StoreGeometryBackingTap.start(store, { database: database() });
  enqueueInstancedShards('ce', [shardBytes(70)], instancedShardGeneration());
  await tap.seal();
  setList(store, 'ce', [mesh(1)]); // a recolour copies the list: the shard carry is pending
  setList(store, 'ce', [mesh(1)]); // and again, before that carry ran
  const [status] = await tap.seal();
  assert.equal(status.shards, 1, 'the pending carry is not dropped by the second edit');
  assert.equal(status.complete, true, status.error ?? 'incomplete');
  await tap.stop();
});

it('#10876 a tap started on a list that is already released never backs it as empty records', async () => {
  const meshes = [mesh(1), mesh(2)];
  releaseCpuMeshBuffers(meshes); // release-for-test, then the tap is stopped and started again
  const store = storeWith({ rl: meshes });
  const tap = await StoreGeometryBackingTap.start(store, { database: database() });
  const [status] = await tap.seal();
  assert.equal(status.complete, false, 'no complete generation of empty records');
  assert.equal(tap.backing('rl'), undefined, 'and no backing answers for it');
  assert.ok(status.error, 'the reason is reported');
  await tap.stop();
});

it('#10876 release-for-test re-checks the models after its awaits: one added meanwhile means nothing is released', async () => {
  const { geometryBackingCommand, activeGeometryBackingTap } = await import('./backing-debug-hook');
  const meshes = [mesh(1)];
  const store = storeWith({ ra: meshes });
  await geometryBackingCommand(store, undefined, { action: 'start', options: { database: database() } as never });
  let released = 0;
  const scene = { releaseGeometryData: () => { released++; }, isGeometryDataReleased: () => released > 0 };
  const renderer = { getScene: () => scene } as never;
  try {
    await geometryBackingCommand(store, undefined, { action: 'seal' });
    const backing = activeGeometryBackingTap()!.backing('ra')!;
    const acknowledge = backing.acknowledge.bind(backing);
    let calls = 0;
    backing.acknowledge = async () => {
      const ack = await acknowledge();
      // release-for-test seals first (call 1), then verifies each model (call 2): the model is added during
      // the verification's await, after the model set was read.
      if (++calls === 2) setList(store, 'rb', [mesh(9)]);
      return ack;
    };
    await assert.rejects(geometryBackingCommand(store, renderer, { action: 'release-for-test' }), /nothing was released/);
    assert.equal(released, 0, 'the scene was not released');
    assert.equal(meshes[0].positions.length, 9, 'and the store arrays are still resident');
  } finally { await geometryBackingCommand(store, undefined, { action: 'stop' }); }
});
