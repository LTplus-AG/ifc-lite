/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStore } from 'zustand/vanilla';
import type { MeshData } from '@ifc-lite/geometry';
import { announceAdoptedInstancedShards, completeInstancedShardSupply, discardInstancedShards, drainInstancedShards, enqueueInstancedShards, instancedShardGeneration, instancedShardSupplyToken } from '@/store/instancedShardQueue';
import { StoreGeometryBackingTap, type TapState } from './store-backing-tap';
import { noteInstancedShardModel } from '@/store/instancedShardModels';
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

/** The renderer's drain: every queued shard is drawn. A seal acknowledges only what the scene drew. */
const drawAll = () => drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'uploaded'); });

describe('store geometry backing tap (test/debug only)', () => {
  it('starts mid-load, writes only appended suffixes and seals a verifiable generation', async () => {
    const store = storeWith({ a: [mesh(1), mesh(2)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    append(store, 'a', [mesh(3)]);
    append(store, 'a', [mesh(4), mesh(5)]);
    enqueueInstancedShards('a', [shardBytes(77)], instancedShardGeneration());
    drawAll(); // the renderer draws what was queued before any seal
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
    drawAll(); // the renderer draws what was queued before any seal
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
    drawAll(); // the renderer draws what was queued before any seal
    const status = Object.fromEntries((await tap.seal()).map((s) => [s.modelId, s]));
    // The replacement cannot vouch for moved occurrences, so it never retires the old generation.
    assert.equal(before.isLive, true, 'the older durable copy survives an unacknowledgeable replacement');
    assert.notEqual(tap.backing('m2a'), before);
    assert.equal(tap.backing('m2a')!.isComplete, false, 'readers through the tap are refused, never served stale');
    assert.equal(status.m2a.instancedLost, true);
    assert.equal(status.m2a.complete, false, 'moved occurrences cannot be vouched for');
    assert.equal(status.m2b.complete, true, 'a model without instancing regenerates completely');
    await tap.stop();
  });

  it('#10903 a content bump that loses instancing still seals its flat records: flatComplete, readable, never isComplete; a later write clears it', async () => {
    const store = storeWith({ fc: [mesh(1), mesh(2, 4)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('fc', [shardBytes(5)], instancedShardGeneration());
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    assert.equal(tap.flatComplete('fc'), false, 'a complete generation is not the flat-only case');
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    assert.equal(tap.flatComplete('fc'), false, 'not before its seal flushed it');
    drawAll(); // the renderer draws what was queued before any seal
    const [status] = await tap.seal();
    assert.equal(status.instancedLost, true);
    assert.equal(tap.backing('fc')!.isComplete, false, 'still never complete: instanced consumers fail closed');
    assert.equal(tap.flatComplete('fc'), true, 'every flat record sealed and durable');
    const lease = await tap.backing('fc')!.reader.leaseEntity(2);
    assert.deepEqual([...lease.meshes[0].positions].slice(0, 3), [0, 0, 4], 'the flat records read back exactly');
    lease.release();
    append(store, 'fc', [mesh(3, 8)]); // a write after the seal
    assert.equal(tap.flatComplete('fc'), false, 'no longer proven whole');
    await tap.stop();
  });

  it('#10888 enqueued + stated complete + sealed BEFORE the drain: never acknowledged; a dropped drain leaves the old copy durable; an uploaded one then commits', async () => {
    for (const outcome of ['dropped', 'uploaded'] as const) {
      const id = `sd-${outcome}`;
      const store = storeWith({ [id]: [mesh(1)] });
      const tap = await StoreGeometryBackingTap.start(store, { database: database() });
      enqueueInstancedShards(id, [shardBytes(70)], instancedShardSupplyToken(id));
      drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'uploaded'); });
      await tap.seal();
      const old = tap.backing(id)!;
      store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 })); // instancing lost
      discardInstancedShards(id); // the producer starts a fresh supply of the model
      const fresh = instancedShardSupplyToken(id);
      enqueueInstancedShards(id, [shardBytes(71)], fresh); // the producer's whole replacement set...
      completeInstancedShardSupply(id, 1, fresh); // ...stated complete
      let [status] = await tap.seal(); // before the renderer drained it
      assert.equal(status.complete, false, `${outcome}: 71 was never drawn, so it cannot be acknowledged`);
      assert.equal(old.isDurablyComplete, true, `${outcome}: the last complete copy stays durable`);
      drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, outcome); });
      [status] = await tap.seal();
      if (outcome === 'dropped') {
        assert.equal(status.complete, false, 'the dropped shard never reached the scene');
        assert.equal(old.isDurablyComplete, true, 'the old durable copy is still the source after the drop');
      } else {
        assert.equal(status.complete, true, status.error ?? 'the drawn set commits once settled');
        assert.deepEqual(await idsIn(tap.backing(id)!), [71]);
      }
      await tap.stop();
    }
  });

  it('removing a model deletes its generation', async () => {
    const store = storeWith({ m3a: [mesh(1)], m3b: [mesh(2)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    const removed = tap.backing('m3a')!;
    store.setState((state) => { const models = new Map(state.models); models.delete('m3a'); return { models }; });
    await tap.whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(removed.isCurrent, false);
    drawAll(); // the renderer draws what was queued before any seal
    assert.deepEqual((await tap.seal()).map((s) => s.modelId), ['m3b']);
    await tap.stop();
  });

  for (const resupply of [true, false]) {
    it(`#10888 shards drawn BEFORE the tap started, then an empty reset ${resupply ? 'and a fresh drawn, stated supply: seal succeeds with exactly the new entities' : 'and no supply: stays unavailable'}`, async () => {
      const id = `pretap-${resupply}`;
      enqueueInstancedShards(id, [shardBytes(5)], instancedShardSupplyToken(id));
      drawAll(); // the renderer drew 5; no tap saw it
      const store = storeWith({ [id]: [mesh(1)] });
      const tap = await StoreGeometryBackingTap.start(store, { database: database() });
      let [status] = await tap.seal();
      assert.equal(status.complete, false, 'the pre-tap occurrence is not backed: unavailable');
      discardInstancedShards(id); // an empty reset of the model's supply
      if (resupply) {
        const fresh = instancedShardSupplyToken(id);
        enqueueInstancedShards(id, [shardBytes(40), shardBytes(41)], fresh);
        completeInstancedShardSupply(id, 2, fresh);
        drawAll();
      }
      [status] = await tap.seal();
      if (resupply) {
        assert.equal(status.error, undefined);
        assert.equal(status.complete, true, 'the fresh supply replaced the old instances whole');
        assert.deepEqual(await idsIn(tap.backing(id)!), [40, 41], 'exactly the new entities, nothing pre-tap');
      } else {
        assert.equal(status.complete, false, 'without a fresh supply the old instances are still unbacked');
        assert.equal(status.instancedLost, true);
      }
      await tap.stop();
    });
  }

  it('a tap started after shards were enqueued fails closed for that model', async () => {
    enqueueInstancedShards('late', [shardBytes(9)], instancedShardGeneration());
    const store = storeWith({ late: [mesh(1)], flat: [mesh(2)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    drawAll(); // the renderer draws what was queued before any seal
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
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    const acknowledged = tap.backing('rel')!;
    releaseCpuMeshBuffers(list);
    const recoloured = list.map((m) => carryReleasedMesh(m, { ...m, color: [1, 0, 0, 1] as [number, number, number, number] }));
    store.setState({ models: new Map([['rel', { geometryResult: { meshes: recoloured }, idOffset: 0 }]]) });
    drawAll(); // the renderer draws what was queued before any seal
    const [status] = await tap.seal();
    assert.equal(status.complete, true, status.error ?? 'incomplete');
    assert.equal(acknowledged.isDurablyComplete, false, 'retired only after the replacement committed');
    const lease = await tap.backing('rel')!.reader.leaseEntity(1);
    assert.equal(lease.meshes[0].positions.length, 9, 'real arrays, never the emptied ones');
    assert.deepEqual(lease.meshes[0].color, [1, 0, 0, 1]);
    lease.release();
    await tap.stop();
  });

  it('#10888 r4655022816 a released mesh appended in place after a prune-to-replay is never backed as complete', async () => {
    const a = mesh(1, 0), b = mesh(2, 1);
    const store = storeWith({ rel: [a, b] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    drawAll();
    await tap.seal();
    releaseCpuMeshBuffers([a, b]);
    const pruned = [a]; // a new array: a replay of the released `a` is staged
    store.setState({ models: new Map([['rel', { geometryResult: { meshes: pruned }, idOffset: 0 }]]) });
    append(store, 'rel', [b]); // the still-released `b` appended in place to that same array
    drawAll();
    const [status] = await tap.seal();
    assert.equal(status.complete, false, 'emptied arrays are never acknowledged as the model\'s geometry');
    await tap.stop();
  });

  it('backs shard ids in the federated id space, as the drain uploads them', async () => {
    const store = storeWith({ fed: [mesh(1)] });
    store.setState((state) => ({ models: new Map([['fed', { ...state.models.get('fed')!, idOffset: 1000 }]]) }));
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('fed', [shardBytes(5)], instancedShardGeneration());
    drawAll(); // the renderer draws what was queued before any seal
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
    drawAll(); // the renderer draws what was queued before any seal
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

  it('lost instancing stays lost through later edits and partial re-supplies, until the model states its fresh set whole', async () => {
    const store = storeWith({ st: [mesh(1)] });
    const recolour = () => store.setState((state) => ({ models: new Map([['st', { ...state.models.get('st')!, geometryResult: {
      meshes: state.models.get('st')!.geometryResult!.meshes.map((m) => ({ ...m, color: [1, 0, 0, 1] as [number, number, number, number] })) } }]]) }));
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('st', [shardBytes(77), shardBytes(78)], instancedShardGeneration());
    completeInstancedShardSupply('st', 2, instancedShardGeneration());
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    const acknowledged = tap.backing('st')!;
    const idsOf = async (backing: typeof acknowledged) => {
      const ids: number[] = [];
      for await (const shard of backing.carryReader.instancedShards()) ids.push(...shard.instances.map((i) => i.entityId));
      return ids.sort();
    };
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 })); // occurrences may have moved
    completeInstancedShardSupply('st', 2, instancedShardGeneration()); // a statement for the pre-loss generation proves nothing
    recolour(); // must not fall back to the pre-bump occurrences
    drawAll(); // the renderer draws what was queued before any seal
    let [status] = await tap.seal();
    assert.equal(status.instancedLost, true, 'the invalidation survives the recolour');
    assert.equal(status.complete, false);
    // A fresh queue generation alone is not completeness: one of two new shards.
    discardInstancedShards();
    const fresh = instancedShardGeneration();
    enqueueInstancedShards('st', [shardBytes(80)], fresh);
    drawAll(); // the renderer draws what was queued before any seal
    [status] = await tap.seal();
    assert.equal(status.complete, false, 'a partial fresh supply is never complete');
    assert.equal(acknowledged.isDurablyComplete, true, 'the acknowledged durable copy survives');
    assert.deepEqual(await idsOf(acknowledged), [77, 78], 'and stays readable with its own occurrences');
    completeInstancedShardSupply('st', 2, fresh); // the producer says two: one has arrived
    drawAll(); // the renderer draws what was queued before any seal
    [status] = await tap.seal();
    assert.equal(status.complete, false, 'a statement the received shards do not match proves nothing');
    completeInstancedShardSupply('other', 1, fresh); // another model's statement is not this model's
    recolour(); // an edit during the re-supply keeps the fresh shard
    enqueueInstancedShards('st', [shardBytes(81)], fresh);
    drawAll(); // the renderer draws what was queued before any seal
    [status] = await tap.seal();
    assert.equal(status.complete, false, 'all shards in, but not yet stated whole');
    completeInstancedShardSupply('st', 2, fresh);
    drawAll(); // the renderer draws what was queued before any seal
    [status] = await tap.seal();
    assert.equal(status.complete, true, status.error ?? 'incomplete');
    assert.equal(acknowledged.isDurablyComplete, false, 'retired only now');
    assert.deepEqual(await idsOf(tap.backing('st')!), [80, 81], 'only the fresh occurrences, never the stale ones');
    await tap.stop();
  });

  it('a global queue reset with no model statement never proves an empty replacement', async () => {
    const store = createStore<TapState>(() => ({ models: new Map([['z0', { geometryResult: { meshes: [mesh(1)] }, idOffset: 0, loadState: 'complete' }]]),
      geometryContentVersion: 0 }) as TapState);
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('z0', [shardBytes(77)], instancedShardGeneration());
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    discardInstancedShards(); // global reset, empty queue, the model's load still reads complete
    store.setState((state) => ({ models: new Map([['z0', { ...state.models.get('z0')!, loadState: 'loading' }]]) }));
    store.setState((state) => ({ models: new Map([['z0', { ...state.models.get('z0')!, loadState: 'complete' }]]) }));
    drawAll(); // the renderer draws what was queued before any seal
    let [status] = await tap.seal();
    assert.equal(status.complete, false, 'load state and an empty queue say nothing about this model');
    completeInstancedShardSupply('z0', 0, instancedShardGeneration()); // the model itself states: no shards
    drawAll(); // the renderer draws what was queued before any seal
    [status] = await tap.seal();
    assert.equal(status.complete, true, status.error ?? 'incomplete');
    assert.equal(status.shards, 0, 'the stale occurrence is not carried');
    await tap.stop();
  });

  for (const scope of ['global', 'model'] as const) {
    it(`#10888 a statement then a ${scope} discard of its queued shards, then seal: incomplete, old copy kept, abandoned shards never carried`, async () => {
      const id = `dz-${scope}`;
      const store = storeWith({ [id]: [mesh(1)] });
      const tap = await StoreGeometryBackingTap.start(store, { database: database() });
      enqueueInstancedShards(id, [shardBytes(77), shardBytes(78)], instancedShardGeneration());
      drawAll(); // the renderer draws what was queued before any seal
      await tap.seal();
      const acknowledged = tap.backing(id)!;
      const idsOf = async (backing: typeof acknowledged) => {
        const ids: number[] = [];
        for await (const shard of backing.carryReader.instancedShards()) ids.push(...shard.instances.map((i) => i.entityId));
        return ids.sort();
      };
      store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
      discardInstancedShards();
      const fresh = instancedShardGeneration();
      enqueueInstancedShards(id, [shardBytes(80), shardBytes(81)], fresh);
      completeInstancedShardSupply(id, 2, fresh); // matched: accepted
      // The load is abandoned before the drain uploads anything.
      if (scope === 'global') discardInstancedShards(); else discardInstancedShards(id);
      drawAll(); // the renderer draws what was queued before any seal
      let [status] = await tap.seal();
      assert.equal(status.complete, false, 'the scene never received the stated set');
      assert.equal(acknowledged.isDurablyComplete, true, 'the acknowledged copy stays durable');
      assert.deepEqual(await idsOf(acknowledged), [77, 78]);
      // A later, real re-supply must hold only its own shards.
      discardInstancedShards();
      const next = instancedShardGeneration();
      enqueueInstancedShards(id, [shardBytes(90)], next);
      completeInstancedShardSupply(id, 1, next);
      drawAll(); // the renderer draws what was queued before any seal
      [status] = await tap.seal();
      assert.equal(status.complete, true, status.error ?? 'incomplete');
      assert.deepEqual(await idsOf(tap.backing(id)!), [90], 'never the abandoned 80, 81 nor the stale 77, 78');
      await tap.stop();
    });
  }

  it('#10888 a statement, then a drain that DROPS the shard, then seal: incomplete and the old copy kept; a later supply completes', async () => {
    const store = storeWith({ dp: [mesh(1)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('dp', [shardBytes(77)], instancedShardGeneration());
    drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'uploaded'); });
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    const acknowledged = tap.backing('dp')!;
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    discardInstancedShards();
    const fresh = instancedShardGeneration();
    enqueueInstancedShards('dp', [shardBytes(80)], fresh);
    completeInstancedShardSupply('dp', 1, fresh); // matched and accepted
    drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'dropped'); }); // never uploaded
    drawAll(); // the renderer draws what was queued before any seal
    let [status] = await tap.seal();
    assert.equal(status.complete, false, 'the scene never received the stated shard');
    assert.equal(acknowledged.isDurablyComplete, true, 'the last complete generation is not retired');
    // The model is re-supplied within the same queue generation (a new epoch of its own).
    enqueueInstancedShards('dp', [shardBytes(81)], fresh);
    completeInstancedShardSupply('dp', 1, fresh);
    drawAll(); // the renderer draws what was queued before any seal
    [status] = await tap.seal();
    assert.equal(status.complete, true, status.error ?? 'incomplete');
    const ids: number[] = [];
    for await (const shard of tap.backing('dp')!.reader.instancedShards()) ids.push(...shard.instances.map((i) => i.entityId));
    assert.deepEqual(ids, [81], 'never the dropped 80');
    await tap.stop();
  });

  it('#10888 a model-scoped discard, then a complete replacement set, completes without any global reset', async () => {
    const store = storeWith({ ms: [mesh(1)], other: [mesh(2)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    const generation = instancedShardGeneration();
    enqueueInstancedShards('ms', [shardBytes(77)], generation);
    await tap.seal(); // 77 still queued: never drawn, so never acknowledged
    const acknowledged = tap.backing('ms')!;
    discardInstancedShards('ms'); // its queued shard never reached the scene; the queue generation does not move
    assert.equal(instancedShardGeneration(), generation);
    drawAll(); // the renderer draws what was queued before any seal
    let [status] = await tap.seal();
    assert.equal(status.complete, false, 'backed but never drawn: lost');
    assert.equal(acknowledged.isLive, true);
    // A partial replacement in the same generation is still not whole.
    enqueueInstancedShards('ms', [shardBytes(90)], generation);
    completeInstancedShardSupply('ms', 2, generation);
    drawAll(); // the renderer draws what was queued before any seal
    [status] = await tap.seal();
    assert.equal(status.complete, false, 'one of two stated shards');
    enqueueInstancedShards('ms', [shardBytes(91)], generation);
    completeInstancedShardSupply('ms', 2, generation);
    drawAll(); // the renderer draws what was queued before any seal
    [status] = await tap.seal();
    assert.equal(status.complete, true, status.error ?? 'incomplete');
    const ids: number[] = [];
    for await (const shard of tap.backing('ms')!.reader.instancedShards()) ids.push(...shard.instances.map((i) => i.entityId));
    assert.deepEqual(ids.sort(), [90, 91]);
    await tap.stop();
  });

  it('#10888 a load still running when its model is discarded cannot supply the next set; a fresh load can', async () => {
    const store = storeWith({ op: [mesh(1)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('op', [shardBytes(77)], instancedShardSupplyToken('op'));
    await tap.seal(); // 77 still queued: the discard below drops it before it is ever drawn
    const acknowledged = tap.backing('op')!;
    const oldLoad = instancedShardSupplyToken('op'); // captured when the old load began
    enqueueInstancedShards('op', [shardBytes(78)], oldLoad);
    discardInstancedShards('op'); // the model's queued shards go; the global generation stays
    // The old producer finishes late: its ENTIRE set and its completion statement.
    enqueueInstancedShards('op', [shardBytes(80), shardBytes(81)], oldLoad);
    completeInstancedShardSupply('op', 2, oldLoad);
    drawAll(); // the renderer draws what was queued before any seal
    let [status] = await tap.seal();
    assert.equal(status.complete, false, 'a superseded load never completes the new supply');
    assert.equal(acknowledged.isLive, true);
    const fresh = instancedShardSupplyToken('op');
    enqueueInstancedShards('op', [shardBytes(90)], fresh);
    completeInstancedShardSupply('op', 1, fresh);
    drawAll(); // the renderer draws what was queued before any seal
    [status] = await tap.seal();
    assert.equal(status.complete, true, status.error ?? 'incomplete');
    const ids: number[] = [];
    for await (const shard of tap.backing('op')!.reader.instancedShards()) ids.push(...shard.instances.map((i) => i.entityId));
    assert.deepEqual(ids, [90], 'only the fresh load');
    await tap.stop();
  });

  it('#10888 an empty statement, then a scoped discard of an EMPTY queue, then seal: the old instanced copy stays', async () => {
    const store = storeWith({ ed: [mesh(1)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('ed', [shardBytes(77)], instancedShardSupplyToken('ed'));
    drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'uploaded'); });
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    const acknowledged = tap.backing('ed')!;
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 })); // instancing lost
    discardInstancedShards();
    completeInstancedShardSupply('ed', 0, instancedShardSupplyToken('ed')); // "this model has no shards": accepted
    discardInstancedShards('ed'); // nothing queued, no event: only the model's epoch moves
    drawAll(); // the renderer draws what was queued before any seal
    const [status] = await tap.seal();
    assert.equal(status.complete, false, 'the cancelled empty statement must not retire the instanced copy');
    assert.equal(acknowledged.isDurablyComplete, true, 'the last instanced backing stays durable');
    const ids: number[] = [];
    for await (const shard of acknowledged.carryReader.instancedShards()) ids.push(...shard.instances.map((i) => i.entityId));
    assert.deepEqual(ids, [77]);
    await tap.stop();
  });

  it('#10888 one drain uploads one shard and drops another: the backing keeps exactly the drawn one, and a supply of the rest completes it', async () => {
    const store = storeWith({ mx: [mesh(1)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('mx', [shardBytes(70)], instancedShardSupplyToken('mx'));
    drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'uploaded'); });
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    const acknowledged = tap.backing('mx')!;
    enqueueInstancedShards('mx', [shardBytes(77), shardBytes(78)], instancedShardSupplyToken('mx'));
    drainInstancedShards((shards, settle) => { settle(shards[0], 'uploaded'); settle(shards[1], 'dropped'); }); // 77 drawn, 78 not
    drawAll(); // the renderer draws what was queued before any seal
    let [status] = await tap.seal();
    assert.equal(status.complete, false, 'the model misses 78: never sealed complete');
    assert.equal(acknowledged.isDurablyComplete, true, 'the last complete generation is kept');
    const idsOf = async (backing: NonNullable<ReturnType<typeof tap.backing>>) => {
      const ids: number[] = [];
      for await (const shard of backing.carryReader.instancedShards()) ids.push(...shard.instances.map((i) => i.entityId));
      return ids.sort();
    };
    assert.deepEqual(await idsOf(tap.backing('mx')!), [70, 77], 'exactly what the scene drew: 77 is kept, 78 withheld');
    // The producer re-supplies only what is missing.
    const fresh = instancedShardSupplyToken('mx');
    enqueueInstancedShards('mx', [shardBytes(79)], fresh);
    completeInstancedShardSupply('mx', 1, fresh);
    drawAll(); // the renderer draws what was queued before any seal
    [status] = await tap.seal();
    assert.equal(status.complete, true, status.error ?? 'incomplete');
    assert.deepEqual(await idsOf(tap.backing('mx')!), [70, 77, 79], 'drawn 70 and 77 plus the new 79, never missing 77');
    await tap.stop();
  });

  const idsIn = async (backing: { reader: { instancedShards(): AsyncIterable<{ instances: { entityId: number }[] }> } }) => {
    const ids: number[] = [];
    for await (const shard of backing.reader.instancedShards()) ids.push(...shard.instances.map((i) => i.entityId));
    return ids.sort();
  };

  it('#10888 two queued entries sharing one ArrayBuffer: dropping one keeps the drawn one backed', async () => {
    const store = storeWith({ mxs: [mesh(1)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    const shared = shardBytes(70);
    enqueueInstancedShards('mxs', [shared, shared], instancedShardSupplyToken('mxs'));
    drainInstancedShards((shards, settle) => { settle(shards[0], 'uploaded'); settle(shards[1], 'dropped'); });
    drawAll(); // the renderer draws what was queued before any seal
    const [status] = await tap.seal();
    assert.equal(status.complete, false, 'one occurrence never reached the scene');
    assert.equal(status.error, undefined, 'the drawn entry is resolved, not a collision failure');
    assert.deepEqual(await idsIn(tap.backing('mxs')!), [70], 'exactly the one drawn entry');
    await tap.stop();
  });

  it('#10888 a model-scoped discard inside consume: the taken shard is withheld, its statement never completes the model', async () => {
    const store = storeWith({ mx: [mesh(1)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    const token = instancedShardSupplyToken('mx');
    enqueueInstancedShards('mx', [shardBytes(70)], token);
    completeInstancedShardSupply('mx', 1, token);
    drainInstancedShards((shards, settle) => { discardInstancedShards('mx'); settle(shards[0], 'waiting'); });
    drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'uploaded'); }); // nothing may come back
    drawAll(); // the renderer draws what was queued before any seal
    const [status] = await tap.seal();
    assert.equal(status.complete, false, 'the scene never drew 70: never complete');
    assert.deepEqual(await idsIn(tap.backing('mx')!), [], 'the voided shard is not backed');
    await tap.stop();
  });

  it('#10888 a shard the queue accepted but the backing never admitted (after a content bump), then dropped: a fresh complete supply still recovers', async () => {
    const store = storeWith({ sx: [mesh(1)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('sx', [shardBytes(77)], instancedShardSupplyToken('sx'));
    drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'uploaded'); });
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 })); // instancing lost here
    enqueueInstancedShards('sx', [shardBytes(78)], instancedShardSupplyToken('sx')); // queue-current, but not after the loss: unbacked
    drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'dropped'); });
    const fresh = instancedShardSupplyToken('sx');
    enqueueInstancedShards('sx', [shardBytes(79)], fresh);
    completeInstancedShardSupply('sx', 1, fresh);
    drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'uploaded'); });
    drawAll(); // the renderer draws what was queued before any seal
    const [status] = await tap.seal();
    assert.equal(status.error, undefined, 'dropping a never-backed shard is not a membership failure');
    assert.equal(status.complete, true, 'the fresh, stated set recovers the model');
    assert.deepEqual(await idsIn(tap.backing('sx')!), [79]);
    await tap.stop();
  });

  it('#10888 a full discard of an EMPTY queue while seal awaits: the voided empty statement never retires the last complete copy', async () => {
    const store = storeWith({ se: [mesh(1)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('se', [shardBytes(77)], instancedShardGeneration());
    drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'uploaded'); });
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    const acknowledged = tap.backing('se')!;
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    discardInstancedShards();
    completeInstancedShardSupply('se', 0, instancedShardGeneration()); // an empty replacement
    const sealing = tap.seal(); // passes its first check, then awaits
    discardInstancedShards(); // nothing pending: no event, only the generation moves
    const [status] = await sealing;
    assert.equal(status.complete, false, 'the statement was voided during the seal');
    assert.equal(acknowledged.isDurablyComplete, true, 'the last complete instanced copy is not retired');
    await tap.stop();
  });

  it('#10888 a full discard after the statement voids it even when it dropped nothing (generation fence)', async () => {
    const store = storeWith({ dg: [mesh(1)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('dg', [shardBytes(77)], instancedShardGeneration());
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    discardInstancedShards();
    const fresh = instancedShardGeneration();
    completeInstancedShardSupply('dg', 0, fresh); // an empty replacement, nothing queued
    discardInstancedShards(); // nothing pending: no event, only the generation moves
    drawAll(); // the renderer draws what was queued before any seal
    const [status] = await tap.seal();
    assert.equal(status.complete, false, 'the empty statement belonged to a superseded generation');
    await tap.stop();
  });

  it('drained (uploaded) fresh shards keep their statement through the seal', async () => {
    const store = storeWith({ dd: [mesh(1)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('dd', [shardBytes(77)], instancedShardGeneration());
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    discardInstancedShards();
    const fresh = instancedShardGeneration();
    enqueueInstancedShards('dd', [shardBytes(80)], fresh);
    completeInstancedShardSupply('dd', 1, fresh);
    drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'uploaded'); });
    drawAll(); // the renderer draws what was queued before any seal
    const [status] = await tap.seal();
    assert.equal(status.complete, true, status.error ?? 'incomplete');
    await tap.stop();
  });

  for (const uploaded of [false, true]) {
    it(`a second reset during a re-supply ${uploaded ? 'after the first fresh shard was uploaded never completes' : 'drops the abandoned shard, so only the next set is backed'}`, async () => {
      const id = `r2-${uploaded}`;
      const store = storeWith({ [id]: [mesh(1)] });
      const tap = await StoreGeometryBackingTap.start(store, { database: database() });
      enqueueInstancedShards(id, [shardBytes(77)], instancedShardGeneration());
      drawAll(); // the renderer draws what was queued before any seal
      await tap.seal();
      store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
      discardInstancedShards();
      enqueueInstancedShards(id, [shardBytes(80)], instancedShardGeneration());
      if (uploaded) drainInstancedShards((shards, settle) => { for (const shard of shards) settle(shard, 'uploaded'); });
      discardInstancedShards(); // superseded mid-supply: shard 80 belongs to an abandoned load
      enqueueInstancedShards(id, [shardBytes(81)], instancedShardGeneration());
      completeInstancedShardSupply(id, 1, instancedShardGeneration());
      drawAll(); // the renderer draws what was queued before any seal
      const [status] = await tap.seal();
      if (uploaded) assert.equal(status.complete, false, 'shard 80 is in the backing, and nothing proves it current');
      else {
        assert.equal(status.complete, true, status.error ?? 'incomplete');
        const ids: number[] = [];
        for await (const shard of tap.backing(id)!.reader.instancedShards()) ids.push(...shard.instances.map((i) => i.entityId));
        assert.deepEqual(ids, [81]);
      }
      await tap.stop();
    });
  }

  it('backs the shards a committed scene snapshot uploaded directly, and only once it commits', async () => {
    const store = storeWith({ sn: [mesh(1)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    const generation = instancedShardGeneration();
    noteInstancedShardModel('sn'); // the snapshot upload counts the model's shards, outside the queue
    drawAll(); // the renderer draws what was queued before any seal
    let [status] = await tap.seal();
    assert.equal(status.complete, false, 'drawn but not yet backed: fail closed');
    announceAdoptedInstancedShards('sn', [shardBytes(77)], generation); // hydrateSceneSnapshot committed
    completeInstancedShardSupply('sn', 1, generation);
    drawAll(); // the renderer draws what was queued before any seal
    [status] = await tap.seal();
    assert.equal(status.complete, true, status.error ?? 'incomplete');
    assert.equal(status.shards, 1);
    await tap.stop();
  });

  it('notifies metadata consumers whenever availability changes in place', async () => {
    const list = [mesh(1)];
    const store = storeWith({ nm: list });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    const metadata = releasedGeometryMetadata()!;
    let seen = releasedGeometryMetadataVersion();
    const changed = () => { const now = releasedGeometryMetadataVersion(), moved = now > seen; seen = now; return moved; };
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    assert.equal(changed(), true, 'a seal makes the generation answer');
    assert.ok(metadata.bounds('nm', 1));
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    assert.equal(changed(), false, 'nothing new acknowledged, nothing to re-read');
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    assert.equal(changed(), true, 'same list identity, but the answer just went away');
    assert.equal(metadata.bounds('nm', 1), undefined);
    drawAll(); // the renderer draws what was queued before any seal
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
    drawAll(); // the renderer draws what was queued before any seal
    assert.equal((await tap.seal())[0].complete, true);
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    drawAll(); // the renderer draws what was queued before any seal
    const [status] = await tap.seal();
    assert.equal(status.instancedLost, false, 'no occurrence could have moved');
    assert.equal(status.complete, true, status.error ?? 'incomplete');
    await tap.stop();
  });

  it('a fresh shard without the model statement never re-supplies lost instancing', async () => {
    const store = storeWith({ nl: [mesh(1)] });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('nl', [shardBytes(77)], instancedShardGeneration());
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    discardInstancedShards();
    enqueueInstancedShards('nl', [shardBytes(90)], instancedShardGeneration());
    drawAll(); // the renderer draws what was queued before any seal
    const [status] = await tap.seal();
    assert.equal(status.complete, false, 'no coverage proof, no completeness');
  });

  it('#10884 a registered model without an id offset keeps its shards, in model 0\'s id space', async () => {
    const store = storeWith({ plain: [mesh(1)] });
    store.setState({ models: new Map([['plain', { geometryResult: { meshes: [mesh(1)] } }]]) }); // no idOffset field
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('plain', [shardBytes(5)], instancedShardGeneration());
    drawAll(); // the renderer draws what was queued before any seal
    await tap.seal();
    const backing = tap.backing('plain')!;
    assert.equal(backing.isComplete, true, 'its instancing is backed, not lost');
    assert.deepEqual(backing.directory.shardsOf(5), [0]);
    await tap.stop();
  });

  it('#10888 r4647508608 an in-place append while seal() awaits the acknowledgement is never acknowledged without it', async () => {
    const list = [mesh(1, 0), mesh(2, 1)];
    const store = storeWith({ sa: list });
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    await tap.whenIdle();
    // The loader appends in place exactly while seal() awaits this generation's acknowledgement.
    const generation = tap.backing('sa')!;
    const acknowledge = generation.acknowledge.bind(generation);
    generation.acknowledge = async () => {
      const pending = acknowledge();
      append(store, 'sa', [mesh(3, 2)]);
      return pending;
    };
    await tap.seal();
    const [status] = await tap.seal();
    assert.equal(status.meshes, 3, 'the appended mesh is consumed');
    const candidate = tap.releaseCandidate('sa');
    if (candidate) {
      // Whatever the allowlist offers must hold every listed mesh, the late one included.
      const lease = await candidate.backing.reader.leaseEntity(3);
      try { assert.equal(lease.meshes.length, 1, 'the late mesh is backed in the offered generation'); } finally { lease.release(); }
    }
    assert.equal(status.complete, true, status.error ?? 'incomplete: the late append must land in a successor, not fail the model');
    const lease = await tap.backing('sa')!.reader.leaseEntity(3);
    try { assert.equal(lease.meshes.length, 1); } finally { lease.release(); }
    await tap.stop();
  });
});
