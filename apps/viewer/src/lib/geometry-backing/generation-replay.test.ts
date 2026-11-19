/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generations replaced after a CPU release (#10264): the replacement is built
 * from the previous generation's records chunk by chunk, the store's current
 * scalars laid over them, and the previous generation stays durable until the
 * replacement commits. A failed replay never deletes the sole durable copy.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStore } from 'zustand/vanilla';
import type { MeshData } from '@ifc-lite/geometry';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { carryReleasedMesh } from '@/lib/released-mesh-provenance';
import { StoreGeometryBackingTap, type TapState } from './store-backing-tap';
import { enqueueInstancedShards, instancedShardGeneration } from '@/store/instancedShardQueue';

/** IFNS v1: one template triangle, one occurrence of `entityId`. */
function shardBytes(entityId: number): ArrayBuffer {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0], normals = [0, 0, 1, 0, 0, 1, 0, 0, 1], indices = [0, 1, 2];
  const dataOffset = 32 + 48 + 88;
  const buffer = new ArrayBuffer(dataOffset + (positions.length + normals.length + indices.length) * 4);
  const view = new DataView(buffer);
  [0x4946_4e53, 1, 1, 1, positions.length, normals.length, indices.length, 0].forEach((w, i) => view.setUint32(i * 4, w, true));
  [0, 9, 0, 9, 0, 3].forEach((w, i) => view.setUint32(32 + i * 4, w, true));
  view.setUint32(84, entityId, true);
  [0.5, 0.5, 0.5, 1].forEach((c, i) => view.setFloat32(88 + i * 4, c, true));
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1].forEach((m, i) => view.setFloat32(104 + i * 4, m, true));
  let cursor = dataOffset;
  for (const v of positions) { view.setFloat32(cursor, v, true); cursor += 4; }
  for (const v of normals) { view.setFloat32(cursor, v, true); cursor += 4; }
  for (const v of indices) { view.setUint32(cursor, v, true); cursor += 4; }
  return buffer;
}

let names = 0;
const database = () => ({ name: `replay-test-${process.pid}-${names++}`, locks: null });

function mesh(expressId: number, z: number): MeshData {
  return { expressId, positions: Float32Array.from([0, 0, z, 1, 0, z, 0, 1, z]), normals: new Float32Array(9),
    indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1], origin: [10, 0, 0] };
}

function setup(id: string, meshes: MeshData[]) {
  return createStore<TapState>(() => ({ models: new Map([[id, { geometryResult: { meshes }, idOffset: 0 }]]), geometryContentVersion: 0 }));
}

async function readAll(tap: StoreGeometryBackingTap, id: string): Promise<MeshData[]> {
  const out: MeshData[] = [];
  for await (const batch of tap.backing(id)!.reader.meshes()) out.push(...batch);
  return out;
}

describe('generation replacement after a CPU release', () => {
  it('a recolour of released meshes keeps the exact arrays and takes the new colour, chunk by chunk', async () => {
    const list = Array.from({ length: 6 }, (_, i) => mesh(i + 1, i));
    const bytes = list.map((m) => [...m.positions]);
    const store = setup('r', list);
    const tap = await StoreGeometryBackingTap.start(store, { database: database(), chunkBytes: 64, queueBytes: 4096 });
    await tap.seal();
    const first = tap.backing('r')!;
    releaseCpuMeshBuffers(list);
    // updateMeshColors' shape: immutable copies that carry the release.
    const recoloured = list.map((m) => carryReleasedMesh(m, { ...m, color: [1, 0, 0, 1] }));
    store.setState({ models: new Map([['r', { geometryResult: { meshes: recoloured }, idOffset: 0 }]]) });
    const [status] = await tap.seal();
    assert.equal(status.complete, true, status.error);
    assert.equal(status.generation, 2);
    assert.equal(first.isCurrent, false, 'the previous generation retires only after the replacement commits');
    const read = await readAll(tap, 'r');
    assert.deepEqual(read.map((m) => [...m.positions]), bytes, 'exact arrays carried from the previous records');
    assert.ok(read.every((m) => m.color[0] === 1 && m.color[1] === 0), 'current colour from the store');
    await tap.stop();
  });

  it('a rebase (origin change) after release is backed over the old arrays', async () => {
    const list = [mesh(1, 0), mesh(2, 1)];
    const store = setup('o', list);
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    await tap.seal();
    releaseCpuMeshBuffers(list);
    for (const m of list) m.origin = [-90, 0, 0]; // RTC rebase moves origin, not positions
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    await tap.seal();
    const read = await readAll(tap, 'o');
    assert.deepEqual(read.map((m) => m.origin), [[-90, 0, 0], [-90, 0, 0]]);
    assert.deepEqual([...read[1].positions], [0, 0, 1, 1, 0, 1, 0, 1, 1]);
    await tap.stop();
  });

  it('a prune after release keeps the remaining meshes, each from its own record', async () => {
    const list = [mesh(1, 0), mesh(2, 1), mesh(3, 2)];
    const store = setup('p', list);
    const tap = await StoreGeometryBackingTap.start(store, { database: database(), chunkBytes: 64, queueBytes: 4096 });
    await tap.seal();
    releaseCpuMeshBuffers(list);
    store.setState({ models: new Map([['p', { geometryResult: { meshes: [list[0], list[2]] }, idOffset: 0 }]]) });
    await tap.seal();
    const read = await readAll(tap, 'p');
    assert.deepEqual(read.map((m) => [m.expressId, m.positions[2]]), [[1, 0], [3, 2]]);
    await tap.stop();
  });

  it('a replay that cannot be answered keeps the previous durable generation', async () => {
    const list = [mesh(1, 0)];
    const store = setup('f', list);
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    await tap.seal();
    const first = tap.backing('f')!;
    releaseCpuMeshBuffers(list);
    // A released mesh the previous generation never held: nothing to carry.
    const stranger = mesh(9, 9);
    releaseCpuMeshBuffers([stranger]);
    store.setState({ models: new Map([['f', { geometryResult: { meshes: [list[0], stranger] }, idOffset: 0 }]]) });
    const [status] = await tap.seal();
    assert.equal(status.complete, false);
    assert.match(status.error ?? '', /no backed record to carry/);
    assert.equal(first.isCurrent, true, 'the sole durable copy is kept');
    const lease = await first.reader.leaseEntity(1);
    assert.equal(lease.meshes.length, 1, 'and still readable');
    lease.release();
    await tap.stop();
  });

  it('overlapping recolours after release coalesce onto the acknowledged source and keep it until acknowledged', async () => {
    const list = Array.from({ length: 4 }, (_, i) => mesh(i + 1, i));
    const bytes = list.map((m) => [...m.positions]);
    const store = setup('o2', list);
    const tap = await StoreGeometryBackingTap.start(store, { database: database(), chunkBytes: 64, queueBytes: 4096 });
    await tap.seal();
    const acknowledged = tap.backing('o2')!;
    releaseCpuMeshBuffers(list);
    // Two edits in one tick: the second's predecessor has not even begun when it is queued.
    const red = list.map((m) => carryReleasedMesh(m, { ...m, color: [1, 0, 0, 1] }));
    store.setState({ models: new Map([['o2', { geometryResult: { meshes: red }, idOffset: 0 }]]) });
    const blue = red.map((m) => carryReleasedMesh(m, { ...m, color: [0, 0, 1, 1] }));
    store.setState({ models: new Map([['o2', { geometryResult: { meshes: blue }, idOffset: 0 }]]) });
    await tap.whenIdle();
    assert.equal(acknowledged.isCurrent, true, 'no replacement retires the acknowledged copy before its own acknowledgement');
    const [status] = await tap.seal();
    assert.equal(status.complete, true, status.error);
    assert.equal(status.generation, 3, 'per-model generation number');
    assert.equal(acknowledged.isCurrent, false, 'retired once the final replacement is acknowledged');
    const read = await readAll(tap, 'o2');
    assert.deepEqual(read.map((m) => [...m.positions]), bytes);
    assert.ok(read.every((m) => m.color[2] === 1 && m.color[0] === 0), 'the latest edit wins');
    await tap.stop();
  });

  it('a prune by in-place splice replays from the snapshot, not the mutated array', async () => {
    const list = [mesh(1, 0), mesh(2, 1), mesh(3, 2)];
    const store = setup('sp', list);
    const tap = await StoreGeometryBackingTap.start(store, { database: database(), chunkBytes: 64, queueBytes: 4096 });
    await tap.seal();
    releaseCpuMeshBuffers(list);
    list.splice(1, 1); // the store's own array, mutated in place
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    const [status] = await tap.seal();
    assert.equal(status.complete, true, status.error);
    const read = await readAll(tap, 'sp');
    assert.deepEqual(read.map((m) => [m.expressId, m.positions[2]]), [[1, 0], [3, 2]]);
    await tap.stop();
  });

  it('a content-version bump on an instanced model after release keeps the acknowledged copy', async () => {
    const list = [mesh(1, 0)];
    const store = setup('ci', list);
    const tap = await StoreGeometryBackingTap.start(store, { database: database() });
    enqueueInstancedShards('ci', [shardBytes(77)], instancedShardGeneration());
    const [first] = await tap.seal();
    assert.equal(first.shards, 1);
    const acknowledged = tap.backing('ci')!;
    releaseCpuMeshBuffers(list);
    store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
    const [status] = await tap.seal();
    assert.equal(status.instancedLost, true);
    assert.equal(status.complete, false, 'moved occurrences cannot be vouched for');
    assert.equal(acknowledged.isCurrent, true, 'the acknowledged durable copy survives');
    const lease = await acknowledged.reader.leaseEntity(1);
    assert.equal(lease.meshes[0].positions.length, 9);
    lease.release();
    const shards = [];
    for await (const shard of acknowledged.reader.instancedShards()) shards.push(shard);
    assert.equal(shards[0].instances[0].entityId, 77, 'with its instancing');
    await tap.stop();
  });
});
