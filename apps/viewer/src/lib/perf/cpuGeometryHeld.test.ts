/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { MeshData } from '@ifc-lite/geometry';

// Loaded after asserting the module exists, so a reverted figure fails on an
// assertion rather than as a file that cannot load.
async function load(): Promise<typeof import('./cpuGeometryHeld.js')> {
  assert.ok(existsSync(new URL('./cpuGeometryHeld.ts', import.meta.url)), 'lib/perf/cpuGeometryHeld.ts must exist');
  return import('./cpuGeometryHeld.js');
}

function mesh(positions: Float32Array, normals: Float32Array, indices: Uint32Array, extra: Partial<MeshData> = {}): MeshData {
  return { expressId: 1, positions, normals, indices, color: [1, 1, 1, 1], ...extra };
}

describe('CPU geometry held (#10264)', () => {
  it('counts an array shared by the store mesh and the scene copy once', async () => {
    const { measureCpuGeometryHeld } = await load();
    const source = mesh(new Float32Array(9), new Float32Array(9), new Uint32Array(3));
    const sceneCopy = { ...source }; // the scene's shallow copy shares the typed arrays
    const held = measureCpuGeometryHeld({
      models: [{ geometryResult: { meshes: [source] } }],
      renderer: { visitCpuGeometry: (visit) => { visit('scene.buckets', sceneCopy.positions, 'positions'); visit('scene.buckets', sceneCopy.normals, 'normals'); visit('scene.buckets', sceneCopy.indices, 'indices'); } },
    });
    assert.equal(held.totalBytes, 36 + 36 + 12);
    assert.equal(held.sharedBytes, 84);
    assert.equal(held.owners['store.models'].reachableBytes, 84);
    assert.equal(held.owners['scene.buckets'].reachableBytes, 84);
    // Letting go of either holder alone frees nothing.
    assert.equal(held.owners['store.models'].exclusiveBytes, 0);
    assert.equal(held.owners['scene.buckets'].exclusiveBytes, 0);
  });

  it('counts a buffer shared by a streaming fragment and finalized scene batch once', async () => {
    const { measureCpuGeometryHeld } = await load();
    const positions = new Float32Array(12);
    const meshData = mesh(positions, new Float32Array(0), new Uint32Array(0));
    const held = measureCpuGeometryHeld({
      models: [{ geometryResult: { meshes: [meshData] } }],
      renderer: { visitCpuGeometry: visit => {
        visit('scene.fragmentPieces', positions, 'positions');
        visit('scene.buckets', positions, 'positions');
      } },
    });
    assert.equal(held.totalBytes, positions.byteLength);
    assert.equal(held.buffers, 1);
    assert.equal(held.owners['scene.fragmentPieces'].reachableBytes, positions.byteLength);
    assert.equal(held.owners['scene.buckets'].reachableBytes, positions.byteLength);
  });

  it('counts an arena viewed by many meshes once, at its full byteLength', async () => {
    const { measureCpuGeometryHeld } = await load();
    const pos = new ArrayBuffer(4 * 90), nrm = new ArrayBuffer(4 * 90), idx = new ArrayBuffer(4 * 30);
    const meshes = [0, 1, 2].map((i) => mesh(new Float32Array(pos, i * 120, 27), new Float32Array(nrm, i * 120, 27), new Uint32Array(idx, i * 40, 9)));
    const held = measureCpuGeometryHeld({ models: [{ geometryResult: { meshes } }] });
    assert.equal(held.totalBytes, 360 + 360 + 120);
    assert.equal(held.buffers, 3);
    assert.deepEqual(held.byKind, { positions: 360, normals: 360, indices: 120, other: 0 });
    // Views cover less than the arena (3 x 108 of 360): the slack still counts, it is still held.
    assert.equal(held.owners['store.models'].viewBytes, 3 * (108 + 108 + 36));
    assert.equal(held.owners['store.models'].exclusiveBytes, 840);
  });

  it('counts released and detached arrays as zero', async () => {
    const { measureCpuGeometryHeld } = await load();
    const released = mesh(new Float32Array(0), new Float32Array(0), new Uint32Array(0));
    const detached = mesh(new Float32Array(30), new Float32Array(30), new Uint32Array(10));
    structuredClone(detached.positions.buffer, { transfer: [detached.positions.buffer] });
    const held = measureCpuGeometryHeld({ models: [{ geometryResult: { meshes: [released, detached] } }] });
    assert.equal(held.totalBytes, 120 + 40); // only the detached mesh's normals and indices remain
    assert.equal(held.byKind.positions, 0);
  });

  it('does not count one mesh list twice when the store lists it under two fields', async () => {
    const { measureCpuGeometryHeld } = await load();
    const result = { meshes: [mesh(new Float32Array(3), new Float32Array(3), new Uint32Array(3))] };
    const held = measureCpuGeometryHeld({ models: [{ geometryResult: result }], geometryResult: result });
    assert.equal(held.totalBytes, 36);
    assert.deepEqual(Object.keys(held.owners), ['store.models']);
  });

  it('preserves undo-stash ownership when it shares the active model list (#10506)', async () => {
    const { measureCpuGeometryHeld } = await load();
    const result = { meshes: [mesh(new Float32Array(3), new Float32Array(3), new Uint32Array(3))] };
    const held = measureCpuGeometryHeld({
      models: [{ geometryResult: result }, { geometryResult: result }],
      geometryResult: result,
      removedMeshes: [{ meshes: result.meshes }, { meshes: result.meshes }],
    });
    assert.equal(held.totalBytes, 36);
    assert.equal(held.sharedBytes, 36);
    assert.deepEqual(Object.keys(held.owners), ['store.models', 'store.removedMeshes']);
    for (const owner of Object.values(held.owners)) {
      assert.equal(owner.reachableBytes, 36);
      assert.equal(owner.exclusiveBytes, 0);
      assert.equal(owner.viewBytes, 36, 'duplicate lists within one holder count once');
    }
  });

  it('returns independent repeatable accounting snapshots (#10506)', async () => {
    const { createCpuGeometryAccount } = await load();
    const account = createCpuGeometryAccount();
    account.visit('store.models', new Float32Array(4), 'positions');
    const first = account.result();
    assert.deepEqual(account.result(), first);
    account.visit('store.models', new Float32Array(4), 'positions');
    const second = account.result();
    assert.equal(first.owners['store.models'].exclusiveBytes, 16);
    assert.equal(second.owners['store.models'].exclusiveBytes, 32);
  });

  it('reports a holder-only buffer as exclusive to that holder', async () => {
    const { createCpuGeometryAccount } = await load();
    const account = createCpuGeometryAccount();
    const shared = new Float32Array(4), own = new Float32Array(8);
    account.visit('store.models', shared, 'positions');
    account.visit('scene.buckets', shared, 'positions');
    account.visit('pick.bvh', own, 'other');
    const held = account.result();
    assert.equal(held.totalBytes, 16 + 32);
    assert.equal(held.owners['pick.bvh'].exclusiveBytes, 32);
    assert.equal(held.owners['scene.buckets'].exclusiveBytes, 0);
    assert.equal(held.byKind.other, 32);
  });

  it('counts the pre-alignment copy and the delete-undo stash as their own holders', async () => {
    const { measureCpuGeometryHeld } = await load();
    const live = mesh(new Float32Array(3), new Float32Array(3), new Uint32Array(3));
    const stashed = mesh(new Float32Array(6), new Float32Array(6), new Uint32Array(6));
    const held = measureCpuGeometryHeld({
      models: [{ geometryResult: { meshes: [live] }, preAlignment: { positions: [new Float32Array(3)], normals: [undefined] } }],
      removedMeshes: [{ meshes: [stashed] }],
    });
    assert.equal(held.owners['store.preAlignment'].exclusiveBytes, 12);
    assert.equal(held.owners['store.removedMeshes'].exclusiveBytes, 24 + 24 + 24);
    assert.equal(held.totalBytes, 36 + 12 + 72);
  });
});
