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
});
