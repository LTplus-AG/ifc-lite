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
import { carryReleasedMesh } from '@/lib/released-mesh-provenance';
import { StoreGeometryBackingTap, type TapState } from './store-backing-tap';
import type { ReleaseState } from './backing-debug-hook';

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

it('#10876 a shard enqueued before its model registers, an unrelated store update, then the model: never acknowledged without that shard', async () => {
  const store = storeWith({ other: [mesh(1)] });
  const tap = await StoreGeometryBackingTap.start(store, { database: database() });
  enqueueInstancedShards('early', [shardBytes(77)], instancedShardGeneration()); // the shard arrives first
  setList(store, 'other', [mesh(2)]); // an unrelated store update while 'early' is not registered yet
  setList(store, 'early', [mesh(3)]); // the model registers, with no new shard
  const status = Object.fromEntries((await tap.seal()).map((row) => [row.modelId, row]));
  assert.equal(status.early.shards, 1, 'the pre-registration generation kept its shard');
  assert.equal(status.early.complete, true, status.early.error ?? 'incomplete');
  const occurrences: number[] = [];
  for await (const shard of tap.backing('early')!.reader.instancedShards()) occurrences.push(...shard.instances.map((i) => i.entityId));
  assert.deepEqual(occurrences, [77], 'complete means WITH its instance, never without it');
  await tap.stop();
});

it('#10876 a recolour of a released list: the retained handle is not current, refuses reads and no longer verifies', async () => {
  const list = [mesh(1), mesh(2, 1)];
  const store = storeWith({ rc: list });
  const tap = await StoreGeometryBackingTap.start(store, { database: database() });
  await tap.seal();
  const retained = tap.backing('rc')!;
  const ack = await retained.acknowledge();
  releaseCpuMeshBuffers(list);
  setList(store, 'rc', list.map((m) => carryReleasedMesh(m, { ...m, color: [1, 0, 0, 1] as [number, number, number, number] })));
  assert.equal(retained.isCurrent, false, 'not current: the store now holds recoloured geometry');
  await assert.rejects(retained.reader.leaseEntity(1), /replaced/i, 'its reader never answers the old colours');
  assert.equal(tap.registryHandle.verify(ack), false, 'and its old acknowledgement no longer verifies');
  await tap.stop();
});

it('#10876 a stale (released) generation is replaced by a fresh resident list under the same id, exactly', async () => {
  const list = [mesh(1)];
  const store = storeWith({ fr: list });
  const tap = await StoreGeometryBackingTap.start(store, { database: database() });
  await tap.seal();
  const old = tap.backing('fr')!;
  releaseCpuMeshBuffers(list);
  setList(store, 'fr', list.map((m) => carryReleasedMesh(m, { ...m, color: [0, 1, 0, 1] as [number, number, number, number] })));
  assert.equal(tap.backing('fr'), undefined, 'stale: answers nothing');
  setList(store, 'fr', [mesh(5, 2), mesh(6, 3)]); // a fresh, resident replacement (a reload of the model)
  const [status] = await tap.seal();
  assert.equal(status.complete, true, status.error ?? 'the fresh list regenerates');
  assert.equal(status.meshes, 2);
  const ids: number[] = [];
  for await (const batch of tap.backing('fr')!.reader.meshes()) ids.push(...batch.map((m) => m.expressId));
  assert.deepEqual(ids.sort(), [5, 6], 'the new backing holds exactly the replacement');
  assert.equal(old.isCurrent, false, 'the retained old handle stays stale');
  await tap.stop();
});

it('#10876 a registered model with no geometry yet (geometryResult null) is not complete, and release-for-test refuses it', async () => {
  const { geometryBackingCommand } = await import('./backing-debug-hook');
  const store = createStore<TapState>(() => ({ models: new Map([['ng', { geometryResult: null }]]), geometryContentVersion: 0 }));
  await geometryBackingCommand(store, undefined, { action: 'start', options: { database: database() } as never });
  let released = 0;
  const renderer = { getScene: () => ({ releaseGeometryData: () => { released++; }, isGeometryDataReleased: () => released > 0 }) } as never;
  try {
    let [status] = await geometryBackingCommand(store, undefined, { action: 'seal' });
    assert.equal(status.complete, false, 'no geometry yet is not a valid empty model');
    await assert.rejects(geometryBackingCommand(store, renderer, { action: 'release-for-test' }), /nothing was released/);
    assert.equal(released, 0);
    setList(store, 'ng', [mesh(1)]); // the first batch arrives
    [status] = await geometryBackingCommand(store, undefined, { action: 'seal' });
    assert.equal(status.complete, true, status.error ?? 'incomplete once its geometry arrived');
    assert.equal(status.meshes, 1);
  } finally { await geometryBackingCommand(store, undefined, { action: 'stop' }); }
});

it('#10876 an in-place append after a seal: the retained acknowledged handle goes stale and the new backing holds the new suffix', async () => {
  const list = [mesh(1)];
  const store = storeWith({ ps: list });
  const tap = await StoreGeometryBackingTap.start(store, { database: database() });
  await tap.seal();
  const retained = tap.backing('ps')!;
  const ack = await retained.acknowledge();
  list.push(mesh(2, 1)); // the loader grows the SAME array after the seal
  store.setState((s) => ({ models: new Map(s.models).set('ps', { geometryResult: { meshes: list } }) }));
  assert.equal(retained.isCurrent, false, 'superseded at once: it lacks the new mesh');
  assert.equal(tap.registryHandle.verify(ack), false, 'and its acknowledgement no longer verifies');
  const [status] = await tap.seal();
  assert.equal(status.complete, true, status.error ?? 'incomplete');
  const ids: number[] = [];
  for await (const batch of tap.backing('ps')!.reader.meshes()) ids.push(...batch.map((m) => m.expressId));
  assert.deepEqual(ids.sort(), [1, 2], 'the new generation holds the whole list, new suffix included');
  await tap.stop();
});

it('#10876 stop() drains a removal whose retirement is still pending, so its records are deleted before the database closes', async () => {
  const { BackingDatabase, CHUNKS } = await import('./backing-database');
  const name = database();
  const store = storeWith({ gone: [mesh(1)] });
  const tap = await StoreGeometryBackingTap.start(store, { database: name });
  await tap.seal();
  const removed = tap.backing('gone')!;
  const session = tap.registryHandle.session; // records are keyed by the page's session
  const original = BackingDatabase.prototype.deleteBacking;
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  BackingDatabase.prototype.deleteBacking = async function (this: unknown, id: string) { await gate; return original.call(this as never, id); };
  try {
    setList(store, 'gone', null); // removed: its retirement (and delete) is deferred
    let stopped = false;
    const stopping = tap.stop().then(() => { stopped = true; });
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(stopped, false, 'stop waits for the pending retirement before closing the database');
    release();
    await stopping;
  } finally { BackingDatabase.prototype.deleteBacking = original; release(); }
  const probe = await BackingDatabase.open({ ...name, session });
  try {
    assert.equal(await probe.count(CHUNKS, removed.backingId), 0, 'no orphan records of the removed model (same session)');
  } finally { probe.close(); }
});

it('#10876 a shard enqueued after a seal: the sealed acknowledgement stops verifying at once, and the next seal holds both shards', async () => {
  const store = storeWith({ ls: [mesh(1)] });
  const tap = await StoreGeometryBackingTap.start(store, { database: database() });
  enqueueInstancedShards('ls', [shardBytes(70)], instancedShardGeneration());
  await tap.seal();
  const sealed = tap.backing('ls')!;
  const ack = await sealed.acknowledge();
  enqueueInstancedShards('ls', [shardBytes(71)], instancedShardGeneration()); // after the seal
  // The window: before the deferred append runs, nothing may still verify without shard 71.
  assert.equal(sealed.isCurrent, false, 'the sealed generation is superseded at enqueue time');
  assert.equal(tap.registryHandle.verify(ack), false, 'and its acknowledgement no longer verifies');
  const [status] = await tap.seal();
  assert.equal(status.complete, true, status.error ?? 'incomplete');
  const ids: number[] = [];
  for await (const shard of tap.backing('ls')!.reader.instancedShards()) ids.push(...shard.instances.map((i) => i.entityId));
  assert.deepEqual(ids.sort(), [70, 71], 'the carried shard and the new one');
  await tap.stop();
});

it('#10876 release-for-test refuses while the tap tracks a model whose shards arrived before it registered', async () => {
  const { geometryBackingCommand } = await import('./backing-debug-hook');
  const meshes = [mesh(1)];
  const store = storeWith({ ok: meshes });
  await geometryBackingCommand(store, undefined, { action: 'start', options: { database: database() } as never });
  let released = 0;
  const renderer = { getScene: () => ({ releaseGeometryData: () => { released++; }, isGeometryDataReleased: () => released > 0 }) } as never;
  try {
    enqueueInstancedShards('pending', [shardBytes(77)], instancedShardGeneration()); // its model is not registered yet
    await assert.rejects(geometryBackingCommand(store, renderer, { action: 'release-for-test' }), /nothing was released/);
    assert.equal(released, 0, 'the scene was not released');
    assert.equal(meshes[0].positions.length, 9, 'and the store arrays stay resident');
  } finally { await geometryBackingCommand(store, undefined, { action: 'stop' }); }
});

const sceneStub = () => {
  let released = 0;
  return { get released() { return released; },
    renderer: { getScene: () => ({ releaseGeometryData: () => { released++; }, isGeometryDataReleased: () => released > 0 }) } as never };
};

it('#10876 a shard enqueued after release-for-test builds no successor from the released arrays; the verified generation stays', async () => {
  const { geometryBackingCommand, activeGeometryBackingTap } = await import('./backing-debug-hook');
  const meshes = [mesh(1), mesh(2)];
  const store = storeWith({ rel: meshes });
  await geometryBackingCommand(store, undefined, { action: 'start', options: { database: database() } as never });
  const scene = sceneStub();
  try {
    const [released] = await geometryBackingCommand(store, scene.renderer, { action: 'release-for-test' });
    assert.equal(scene.released, 1, 'the verified model was released');
    const tap = activeGeometryBackingTap()!;
    enqueueInstancedShards('rel', [shardBytes(80)], instancedShardGeneration()); // after its arrays were released
    const [after] = await tap.seal();
    assert.equal(after.generation, released.generation, 'no successor generation was built from the released arrays');
    assert.equal(after.complete, false, 'and nothing reports the model complete without the new shard');
    assert.match(after.error ?? '', /released/, 'the refusal is reported');
    // The sync path too: an in-place append to the released list builds nothing from it.
    meshes.push(mesh(3));
    store.setState({ geometryContentVersion: 0 });
    const [appended] = await tap.seal();
    assert.equal(appended.generation, released.generation, 'an append after release builds no successor either');
  } finally { await geometryBackingCommand(store, undefined, { action: 'stop' }); }
});

it('#10876 a root geometryResult with no model entries is never released unverified', async () => {
  const { geometryBackingCommand } = await import('./backing-debug-hook');
  const meshes = [mesh(1)];
  const store = createStore<ReleaseState>(() => ({ models: new Map(), geometryContentVersion: 0, geometryResult: { meshes } }));
  await geometryBackingCommand(store, undefined, { action: 'start', options: { database: database() } as never });
  const scene = sceneStub();
  try {
    await assert.rejects(geometryBackingCommand(store, scene.renderer, { action: 'release-for-test' }), /nothing was released/);
    assert.equal(scene.released, 0, 'the scene was not released');
    assert.equal(meshes[0].positions.length, 9, 'and the root arrays stay resident');
  } finally { await geometryBackingCommand(store, undefined, { action: 'stop' }); }
});

it('#10876 property: a scene with any unverified geometry source never releases; a fully verified one does', async () => {
  const { geometryBackingCommand } = await import('./backing-debug-hook');
  let seed = 10876;
  const next = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  const KINDS = ['root-not-owned', 'removed-stash', 'unregistered-shards', 'no-geometry-yet', 'released-at-start'] as const;
  for (let trial = 0; trial < 16; trial++) {
    const control = trial === 0;
    const kinds = control ? [] : KINDS.filter(() => next(2) === 1);
    if (!control && kinds.length === 0) kinds.push(KINDS[next(KINDS.length)]);
    const verifiedCount = control ? 1 + next(3) : next(3);
    const models = new Map<string, { geometryResult: { meshes: MeshData[] } | null }>();
    const lists: MeshData[][] = [];
    for (let i = 0; i < verifiedCount; i++) { const list = many(1 + next(3), 100 * i + 1); lists.push(list); models.set(`p${trial}v${i}`, { geometryResult: { meshes: list } }); }
    const state: ReleaseState = { models, geometryContentVersion: 0, geometryResult: lists[0] ? { meshes: lists[0] } : null };
    const unverified: MeshData[][] = [];
    if (kinds.includes('root-not-owned')) { const list = [mesh(900)]; unverified.push(list); state.geometryResult = { meshes: list }; }
    if (kinds.includes('removed-stash')) { const list = [mesh(901)]; unverified.push(list); state.removedMeshes = new Map([[1, { meshes: list }]]); }
    if (kinds.includes('no-geometry-yet')) models.set(`p${trial}null`, { geometryResult: null });
    if (kinds.includes('released-at-start')) {
      const list = [mesh(902)]; releaseCpuMeshBuffers(list);
      models.set(`p${trial}rel`, { geometryResult: { meshes: list } });
    }
    const store = createStore<ReleaseState>(() => state);
    await geometryBackingCommand(store, undefined, { action: 'start', options: { database: database() } as never });
    if (kinds.includes('unregistered-shards')) enqueueInstancedShards(`p${trial}shard`, [shardBytes(903)], instancedShardGeneration());
    const scene = sceneStub();
    try {
      if (control) {
        await geometryBackingCommand(store, scene.renderer, { action: 'release-for-test' });
        assert.equal(scene.released, 1, `trial ${trial}: a fully verified scene releases`);
      } else {
        await assert.rejects(geometryBackingCommand(store, scene.renderer, { action: 'release-for-test' }), /nothing was released/,
          `trial ${trial} (${kinds.join(', ')}, ${verifiedCount} verified)`);
        assert.equal(scene.released, 0, `trial ${trial} (${kinds.join(', ')}): the scene was not released`);
        for (const list of [...lists, ...unverified]) assert.equal(list[0].positions.length, 9, `trial ${trial}: arrays stay resident`);
      }
    } finally { await geometryBackingCommand(store, undefined, { action: 'stop' }); }
  }
});

it('#10876 r4640795851: a content bump after a sealed instanced list is released loses its instancing; a later fresh list never carries pre-change occurrences', async () => {
  const meshes = [mesh(1)];
  const store = storeWith({ ri: meshes });
  const tap = await StoreGeometryBackingTap.start(store, { database: database() });
  try {
    enqueueInstancedShards('ri', [shardBytes(95)], instancedShardGeneration());
    const [sealed] = await tap.seal();
    assert.equal(sealed.complete, true, sealed.error ?? 'incomplete');
    releaseCpuMeshBuffers(meshes); // release-for-test, in place
    store.setState({ geometryContentVersion: 1 }); // the content changed while the list is released
    setList(store, 'ri', [mesh(1, 5)]); // a fresh resident list, no further bump
    const [after] = await tap.seal();
    assert.equal(after.instancedLost, true, 'the pre-change occurrences are lost, not carried');
    assert.equal(after.complete, false, 'and nothing reports the model complete with them');
    assert.equal(tap.releaseCandidate('ri'), undefined, 'so the allowlist offers nothing');
  } finally { await tap.stop(); }
});

it('#10876 r4640795866: a valid shard and an undecodable one in one event: the seal never acknowledges the valid prefix as complete', async () => {
  const store = storeWith({ bad: [mesh(1)] });
  const tap = await StoreGeometryBackingTap.start(store, { database: database() });
  try {
    try { enqueueInstancedShards('bad', [shardBytes(96), new ArrayBuffer(0)], instancedShardGeneration()); } catch { /* the queue's own error path */ }
    const [status] = await tap.seal();
    assert.equal(status.complete, false, 'a failed shard keeps the model incomplete');
    assert.ok(status.error, 'and the failure is reported');
    assert.equal(tap.releaseCandidate('bad'), undefined, 'so the allowlist offers nothing');
  } finally { await tap.stop(); }
});

it('#10876 r4640725592 pin: a content-version bump while a shard-first model is unregistered never lets release take an unverified list', async () => {
  const { geometryBackingCommand, activeGeometryBackingTap } = await import('./backing-debug-hook');
  const store = createStore<ReleaseState>(() => ({ models: new Map(), geometryContentVersion: 0 }));
  await geometryBackingCommand(store, undefined, { action: 'start', options: { database: database() } as never });
  const scene = sceneStub();
  try {
    const tap = activeGeometryBackingTap()!;
    enqueueInstancedShards('early-pin', [shardBytes(90)], instancedShardGeneration()); // before its model registers
    store.setState({ geometryContentVersion: 1 }); // a content bump while `early-pin` is absent
    const meshes = [mesh(1), mesh(2)];
    store.setState({ models: new Map([['early-pin', { geometryResult: { meshes } }]]) }); // registers later, no bump
    const [status] = await tap.seal();
    const candidate = tap.releaseCandidate('early-pin');
    // The invariant: whatever the allowlist offers is exactly the model's list, wholly consumed and verified.
    if (candidate) {
      assert.equal(candidate.meshes, meshes, 'the candidate is the exact store list');
      assert.equal(status.meshes, meshes.length, 'every mesh of it was backed');
      assert.equal(tap.registryHandle.verify(await candidate.backing.acknowledge()), true, 'and it verifies');
      let backed = 0;
      for (const id of [1, 2]) { const lease = await candidate.backing.reader.leaseEntity(id); try { backed += lease.meshes.length; } finally { lease.release(); } }
      assert.equal(backed, meshes.length, 'the backed flat records are exactly those meshes');
    }
    await geometryBackingCommand(store, scene.renderer, { action: 'release-for-test' });
    assert.equal(scene.released, 1, 'release took only the verified list');
    // Recorded, not asserted as wanted: the pre-bump shard is still counted (follow-up: mark it instancedLost).
    console.log(`[r4640725592] candidate=${!!candidate} shards=${status.shards} instancedLost=${status.instancedLost}`);
  } finally { await geometryBackingCommand(store, undefined, { action: 'stop' }); }
});
