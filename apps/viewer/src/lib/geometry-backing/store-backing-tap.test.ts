/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStore } from 'zustand/vanilla';
import type { MeshData } from '@ifc-lite/geometry';
import { discardInstancedShards, drainInstancedShards, enqueueInstancedShards, instancedShardGeneration } from '@/store/instancedShardQueue';
import { StoreGeometryBackingTap, type TapState } from './store-backing-tap';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { carryReleasedMesh } from '@/lib/released-mesh-provenance';
import { releasedGeometryMetadata, releasedGeometryMetadataVersion } from './released-geometry-metadata';
import { collectMeshAreas } from '@/components/viewer/tools/measure-modes/mesh-area';

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
    models: new Map(Object.entries(models).map(([id, meshes]) => [id, { geometryResult: { meshes }, idOffset: 0 }])),
    geometryContentVersion: 0,
  }));
}

/** The loader's in-place append: same array, new record object. */
function append(store: ReturnType<typeof storeWith>, modelId: string, meshes: MeshData[]): void {
  store.setState((state) => {
    const models = new Map(state.models);
    const target = models.get(modelId)!.geometryResult!;
    target.meshes.push(...meshes);
    models.set(modelId, { geometryResult: { meshes: target.meshes }, idOffset: 0 });
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
    store.setState((state) => ({ models: new Map([['m1a', { idOffset: 0, geometryResult: {
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

  it('a content-version bump fails closed for instanced models and keeps the old copy', async () => {
    const store = storeWith({ m2a: [mesh(1)], m2b: [mesh(2)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('m2a', [shardBytes(5)], instancedShardGeneration());
    await tap.whenIdle();
    const before = tap.backing('m2a')!;
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    const status = Object.fromEntries((await tap.seal()).map((s) => [s.modelId, s]));
    // The replacement cannot vouch for moved occurrences, so it never retires the old generation.
    assert.equal(before.isCurrent, true, 'the older durable copy survives an unacknowledgeable replacement');
    assert.notEqual(tap.backing('m2a'), before);
    assert.equal(tap.backing('m2a')!.isComplete, false, 'readers through the tap are refused, never served stale');
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

  it('never backs emptied records: a released list is replayed from the acknowledged generation', async () => {
    const list = [mesh(1, 0), mesh(2, 1)];
    const store = storeWith({ rel: list });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    await tap.seal();
    const acknowledged = tap.backing('rel')!;
    releaseCpuMeshBuffers(list);
    const recoloured = list.map((m) => carryReleasedMesh(m, { ...m, color: [1, 0, 0, 1] as [number, number, number, number] }));
    store.setState({ models: new Map([['rel', { geometryResult: { meshes: recoloured }, idOffset: 0 }]]) });
    const [status] = await tap.seal();
    assert.equal(status.complete, true, status.error ?? 'incomplete');
    assert.equal(acknowledged.isCurrent, false, 'retired only after the replacement committed');
    const lease = await tap.backing('rel')!.reader.leaseEntity(1);
    assert.equal(lease.meshes[0].positions.length, 9, 'real arrays, never the emptied ones');
    assert.deepEqual(lease.meshes[0].color, [1, 0, 0, 1]);
    lease.release();
    await tap.stop();
  });

  it('backs shard ids in the federated id space, as the drain uploads them', async () => {
    const store = storeWith({ fed: [mesh(1)] });
    store.setState((state) => ({ models: new Map([['fed', { ...state.models.get('fed')!, idOffset: 1000 }]]) }));
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('fed', [shardBytes(5)], instancedShardGeneration());
    await tap.seal();
    const backing = tap.backing('fed')!;
    assert.deepEqual(backing.directory.shardsOf(1005), [0], 'global id');
    assert.deepEqual(backing.directory.shardsOf(5), [], 'not the model-local id');
    await tap.stop();
  });

  it('answers bounds and mesh areas of a complete generation as the resident arrays would', async () => {
    const list = [mesh(1, 0), mesh(2, 5), mesh(1, 2)];
    const expected = collectMeshAreas([list]);
    const store = storeWith({ meta: list.slice(0, 2) });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    append(store, 'meta', [list[2]]); // entity 1's second piece arrives in a later batch
    assert.equal(releasedGeometryMetadata()?.area('meta', 1), undefined, 'not before the generation is complete');
    await tap.seal();
    const metadata = releasedGeometryMetadata()!;
    assert.deepEqual(metadata.area('meta', 1), expected.get(1), 'two pieces of one entity sum as one pass would');
    assert.deepEqual(metadata.area('meta', 2), expected.get(2));
    assert.deepEqual(metadata.bounds('meta', 1), { min: [0, 0, 0], max: [1, 1, 2] });
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    assert.equal(metadata.bounds('meta', 1), undefined, 'a superseded generation answers nothing');
    await tap.stop();
    assert.equal(releasedGeometryMetadata(), null);
  });

  it('lost instancing stays lost through later edits and partial re-supplies, until a completed load proves it whole', async () => {
    const store = storeWith({ st: [mesh(1)] });
    const setLoad = (loadState: string) => store.setState((state) => ({ models: new Map([['st', { ...state.models.get('st')!, loadState }]]) }));
    const recolour = () => store.setState((state) => ({ models: new Map([['st', { ...state.models.get('st')!, geometryResult: {
      meshes: state.models.get('st')!.geometryResult!.meshes.map((m) => ({ ...m, color: [1, 0, 0, 1] as [number, number, number, number] })) } }]]) }));
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('st', [shardBytes(77), shardBytes(78)], instancedShardGeneration());
    await tap.seal();
    const acknowledged = tap.backing('st')!;
    const idsOf = async (backing: typeof acknowledged) => {
      const ids: number[] = [];
      for await (const shard of backing.reader.instancedShards()) ids.push(...shard.instances.map((i) => i.entityId));
      return ids.sort();
    };
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 })); // occurrences may have moved
    recolour(); // must not fall back to the pre-bump occurrences
    let [status] = await tap.seal();
    assert.equal(status.instancedLost, true, 'the invalidation survives the recolour');
    assert.equal(status.complete, false);
    // A fresh queue generation alone is not completeness: one of two new shards, the load still running.
    discardInstancedShards();
    setLoad('loading');
    enqueueInstancedShards('st', [shardBytes(80)], instancedShardGeneration());
    [status] = await tap.seal();
    assert.equal(status.complete, false, 'a partial fresh supply is never complete');
    assert.equal(acknowledged.isCurrent, true, 'the acknowledged durable copy survives');
    assert.deepEqual(await idsOf(acknowledged), [77, 78], 'and stays readable with its own occurrences');
    recolour(); // an edit during the re-supply keeps the fresh shard
    enqueueInstancedShards('st', [shardBytes(81)], instancedShardGeneration());
    setLoad('complete'); // load done, but two shards are still queued for upload
    [status] = await tap.seal();
    assert.equal(status.complete, false, 'shards still pending: not yet whole');
    assert.equal(acknowledged.isCurrent, true);
    drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'uploaded'); });
    [status] = await tap.seal(); // the drain is the last step: now proven whole
    assert.equal(status.complete, true, status.error ?? 'incomplete');
    assert.equal(acknowledged.isCurrent, false, 'retired only now');
    assert.deepEqual(await idsOf(tap.backing('st')!), [80, 81], 'only the fresh occurrences, never the stale ones');
    await tap.stop();
  });

  it('notifies metadata consumers whenever availability changes in place', async () => {
    const list = [mesh(1)];
    const store = storeWith({ nm: list });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    const metadata = releasedGeometryMetadata()!;
    let seen = releasedGeometryMetadataVersion();
    const changed = () => { const now = releasedGeometryMetadataVersion(), moved = now > seen; seen = now; return moved; };
    await tap.seal();
    assert.equal(changed(), true, 'a seal makes the generation answer');
    assert.ok(metadata.bounds('nm', 1));
    await tap.seal();
    assert.equal(changed(), false, 'nothing new acknowledged, nothing to re-read');
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    assert.equal(changed(), true, 'same list identity, but the answer just went away');
    assert.equal(metadata.bounds('nm', 1), undefined);
    await tap.seal();
    assert.equal(changed(), true);
    assert.ok(metadata.bounds('nm', 1));
    const released = [mesh(2)];
    releaseCpuMeshBuffers(released);
    list.push(released[0]); // grows in place with a member that has no arrays
    store.setState((state) => ({ models: new Map(state.models) }));
    assert.equal(changed(), true, 'a stale generation stops answering in place');
    assert.equal(metadata.bounds('nm', 1), undefined);
    await tap.stop();
    assert.equal(changed(), true, 'the provider goes away');
  });

  it('empty shard records (no occurrences) never make a content bump lose instancing', async () => {
    const store = storeWith({ fz: [mesh(1)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    const empty = new ArrayBuffer(32); // IFNS v1, no templates, no instances
    new Uint32Array(empty).set([0x4946_4e53, 1, 0, 0, 0, 0, 0, 0]);
    enqueueInstancedShards('fz', [empty], instancedShardGeneration());
    assert.equal((await tap.seal())[0].complete, true);
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    const [status] = await tap.seal();
    assert.equal(status.instancedLost, false, 'no occurrence could have moved');
    assert.equal(status.complete, true, status.error ?? 'incomplete');
    await tap.stop();
  });

  it('a fresh shard without a load cycle never re-supplies lost instancing', async () => {
    const store = storeWith({ nl: [mesh(1)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('nl', [shardBytes(77)], instancedShardGeneration());
    await tap.seal();
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    discardInstancedShards();
    enqueueInstancedShards('nl', [shardBytes(90)], instancedShardGeneration());
    const [status] = await tap.seal();
    assert.equal(status.complete, false, 'no coverage proof, no completeness');
    await tap.stop();
  });
});
