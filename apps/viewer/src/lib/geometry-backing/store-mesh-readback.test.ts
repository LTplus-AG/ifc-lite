/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
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
    assert.deepEqual([...all.meshes[0].positions], [...originals[2].positions], 'exact bytes of that mesh');
    all.release();
    const cut = await leaseStoreMeshes(source, [{ modelId: 'm', meshes: list }], wanted, { slab: cutSlab({ axis: 'y', position: 0 }, 0.5) });
    assert.deepEqual(cut.meshes.map((m) => m.expressId), [3, 1], 'far meshes are not read back for a cut');
    cut.release();
    backing.reader.clear();
    assert.equal(backing.reader.retainedBytes, 0);
    await registry.close();
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
});
