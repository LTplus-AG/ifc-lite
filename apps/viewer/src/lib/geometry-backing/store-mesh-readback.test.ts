/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { carryReleasedMesh } from '@/lib/released-mesh-provenance';
import { GeometryBackingRegistry } from './geometry-backing-registry';
import { GeometryUnavailableError } from './geometry-readback';
import { boxMeetsSlab, leaseStoreMeshes } from './store-mesh-readback';
import { cutSlab } from './cut-readback';

let names = 0;
const database = () => ({ name: `store-readback-${process.pid}-${names++}`, locks: null });

/** A triangle at height y (mesh frame). */
function mesh(expressId: number, y: number): MeshData {
  return { expressId, positions: Float32Array.from([0, y, 0, 1, y, 0, 0, y, 1]), normals: new Float32Array(9),
    indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] };
}
const copy = (m: MeshData): MeshData => ({ ...m, positions: m.positions.slice(), normals: m.normals.slice(), indices: m.indices.slice() });

async function released(list: MeshData[]) {
  const registry = await GeometryBackingRegistry.open(database());
  const backing = await registry.begin('m', { chunkBytes: 64, queueBytes: 4096 });
  await backing.writer.append(list.map(copy));
  await backing.writer.close();
  releaseCpuMeshBuffers(list);
  return { registry, backing, source: { backing: (id: string) => (id === 'm' ? backing : undefined) } };
}

describe('store mesh readback for cut and export tools', () => {
  it('#10887 tool readback preserves a copy with its origin cleared', async () => {
    const list = [{ ...mesh(1, 0), origin: [10, 0, 0] as [number, number, number] }];
    const { registry, source } = await released(list);
    try {
      const current = carryReleasedMesh(list[0], { ...list[0], origin: undefined });
      const lease = await leaseStoreMeshes(source, [{ modelId: 'm', meshes: list }], [current]);
      try {
        assert.equal(lease.meshes[0].origin, undefined, 'current scalar absence overrides the stored offset');
      } finally { lease.release(); }
    } finally { await registry.close(); }
  });

  it('#10887 a slab considers every placement of copies from the same model', async () => {
    const list = [mesh(1, 0)];
    const { registry, source } = await released(list);
    try {
      const translated = carryReleasedMesh(list[0], { ...list[0], origin: [100, 0, 0], modelIndex: 2 });
      for (const wanted of [[list[0], translated], [translated, list[0]]]) {
        const lease = await leaseStoreMeshes(source, [{ modelId: 'm', meshes: list }], wanted,
          { slab: { normal: [1, 0, 0], min: 100.5, max: 100.5 } });
        try {
          const placed = lease.meshes.find((copy) => copy.modelIndex === 2);
          assert.ok(placed, 'the translated copy must survive even when the first copy misses the slab');
          assert.deepEqual(placed.origin, [100, 0, 0]);
          assert.deepEqual([...placed.positions], [0, 0, 0, 1, 0, 0, 0, 0, 1]);
        } finally { lease.release(); }
      }
    } finally { await registry.close(); }
  });

  it('slab geometry: boxes and cut planes, cardinal and custom', () => {
    assert.equal(boxMeetsSlab([0, 0, 0], [1, 1, 1], { normal: [0, 1, 0], min: 0.5, max: 0.6 }), true);
    assert.equal(boxMeetsSlab([0, 2, 0], [1, 3, 1], { normal: [0, 1, 0], min: 0.5, max: 0.6 }), false);
    const diagonal = Math.SQRT1_2;
    assert.equal(boxMeetsSlab([0, 0, 0], [1, 1, 1], { normal: [diagonal, diagonal, 0], min: 1.4, max: 1.42 }), true);
    assert.equal(boxMeetsSlab([0, 0, 0], [1, 1, 1], { normal: [diagonal, diagonal, 0], min: 1.5, max: 1.6 }), false);
    const plan = cutSlab({ axis: 'y', position: 3 }, 1.5);
    assert.deepEqual(plan.normal, [0, 1, 0]);
    assert.ok(Math.abs(plan.min - 1.499) < 1e-9 && Math.abs(plan.max - 4.501) < 1e-9);
    const custom = cutSlab({ axis: 'x', position: 0, customPlane: { normal: { x: 0, y: 0, z: 1 }, distance: 2,
      origin: { x: 0, y: 0, z: 2 }, tangent: { x: 1, y: 0, z: 0 }, bitangent: { x: 0, y: 1, z: 0 } } }, 0);
    assert.deepEqual(custom.normal, [0, 0, 1]);
    assert.ok(Math.abs(custom.min - 1.999) < 1e-9);
  });

  it('resident lists pass through untouched', async () => {
    const list = [mesh(1, 0)];
    const lease = await leaseStoreMeshes(undefined, [{ modelId: 'm', meshes: list }], list);
    assert.equal(lease.meshes[0], list[0]);
  });

  it('answers each released member with its own record, in wanted order, limited to the slab', async () => {
    const list = [mesh(1, 0), mesh(2, 10), mesh(3, 0.2), mesh(4, 20)];
    const originals = list.map(copy);
    const { registry, backing, source } = await released(list);
    assert.ok(backing.directory.chunks.length >= 4, 'one mesh per chunk');
    const wanted = [list[2], list[0], list[3]];
    const all = await leaseStoreMeshes(source, [{ modelId: 'm', meshes: list }], wanted);
    assert.deepEqual(all.meshes.map((m) => m.expressId), [3, 1, 4]);
    // Every result's payload, not only its id (which is carried from the request): r4653239415.
    [2, 0, 3].forEach((source, i) => {
      assert.deepEqual([...all.meshes[i].positions], [...originals[source].positions], `exact positions of mesh ${source + 1}`);
      assert.deepEqual([...all.meshes[i].indices], [...originals[source].indices], `exact indices of mesh ${source + 1}`);
    });
    all.release();
    const cut = await leaseStoreMeshes(source, [{ modelId: 'm', meshes: list }], wanted, { slab: cutSlab({ axis: 'y', position: 0 }, 0.5) });
    assert.deepEqual(cut.meshes.map((m) => m.expressId), [3, 1], 'far meshes are not read back for a cut');
    cut.release();
    backing.reader.clear();
    assert.equal(backing.reader.retainedBytes, 0);
    await registry.close();
  });

  it('#10887 r4653239417 a model replaced while another model is read is refused, never answered from a superseded generation', async () => {
    const registry = await GeometryBackingRegistry.open(database());
    const listA = [mesh(1, 0)], listB = [mesh(2, 5)];
    const a = await registry.begin('a', { chunkBytes: 64, queueBytes: 4096 });
    await a.writer.append(listA.map(copy)); await a.writer.close();
    const b = await registry.begin('b', { chunkBytes: 64, queueBytes: 4096 });
    await b.writer.append(listB.map(copy)); await b.writer.close();
    releaseCpuMeshBuffers([...listA, ...listB]);
    const source = { backing: (id: string) => (id === 'a' ? a : id === 'b' ? b : undefined) };
    const read = b.reader.leaseChunks.bind(b.reader);
    b.reader.leaseChunks = async (indices, options) => { await registry.begin('a'); return read(indices, options); }; // A replaced meanwhile
    try {
      assert.equal(a.isCurrent, true);
      await assert.rejects(leaseStoreMeshes(source, [{ modelId: 'a', meshes: listA }, { modelId: 'b', meshes: listB }], [listA[0], listB[0]]),
        GeometryUnavailableError, 'A was read from a generation that is no longer current');
      assert.equal(a.isCurrent, false, 'precondition: the replacement superseded A');
    } finally { await registry.close(); }
  });

  it('fails closed when the backing no longer holds the store list', async () => {
    const list = [mesh(1, 0), mesh(2, 1)];
    const { registry, source } = await released(list);
    const grown = [...list, mesh(3, 2)];
    releaseCpuMeshBuffers([grown[2]]);
    await assert.rejects(leaseStoreMeshes(source, [{ modelId: 'm', meshes: grown }], [grown[0]]), GeometryUnavailableError);
    await assert.rejects(leaseStoreMeshes(undefined, [{ modelId: 'm', meshes: list }], [list[0]]), GeometryUnavailableError);
    await assert.rejects(leaseStoreMeshes(source, [], [list[0]]), GeometryUnavailableError, 'an unowned released mesh');
    await registry.close();
  });

  it('answers federated and placed copies by provenance, with their own modelIndex and placement', async () => {
    const list = [mesh(1, 0), mesh(2, 10)];
    const originals = list.map(copy);
    const { registry, backing, source } = await released(list);
    // useFederatedGeometry's re-home and placedViewGeometry's shift, made after release.
    const federated = list.map((m) => carryReleasedMesh(m, { ...m, modelIndex: 3 }));
    const placed = federated.map((m) => carryReleasedMesh(m, { ...m, origin: [100, 0, 0] as [number, number, number] }));
    const all = await leaseStoreMeshes(source, [{ modelId: 'm', meshes: list }], placed);
    assert.deepEqual(all.meshes.map((m) => [m.modelIndex, m.origin, [...m.positions]]),
      originals.map((m) => [3, [100, 0, 0], [...m.positions]]));
    all.release();
    // A cut in the placed frame selects by the same geometry it would cut while resident.
    const cut = await leaseStoreMeshes(source, [{ modelId: 'm', meshes: list }], placed,
      { slab: { normal: [1, 0, 0], min: 100.2, max: 100.4 } });
    assert.deepEqual(cut.meshes.map((m) => m.expressId), [1, 2], 'x 0..1 shifted by +100 meets 100.2..100.4');
    cut.release();
    const missed = await leaseStoreMeshes(source, [{ modelId: 'm', meshes: list }], placed,
      { slab: { normal: [1, 0, 0], min: 0.2, max: 0.4 } });
    assert.deepEqual(missed.meshes, [], 'the unplaced frame is not where the copies are');
    missed.release();
    backing.reader.clear();
    assert.equal(backing.reader.retainedBytes, 0);
    await registry.close();
  });

  it('releases every lease when a read fails part way', async () => {
    const list = [mesh(1, 0), mesh(2, 10), mesh(3, 20)];
    const { registry, backing, source } = await released(list);
    await assert.rejects(leaseStoreMeshes(source, [{ modelId: 'm', meshes: list }], list, { budgetBytes: 200 }), GeometryUnavailableError);
    backing.reader.clear();
    assert.equal(backing.reader.retainedBytes, 0, 'no chunk stays pinned by the failed read');
    await registry.close();
  });
});
