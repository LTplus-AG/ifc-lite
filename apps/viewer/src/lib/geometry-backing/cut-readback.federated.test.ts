/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section caps over released geometry receive what the consumers receive: the
 * federation's re-homed copies (`useFederatedGeometry`) and placed copies
 * (`placedMesh`), not the store's own objects (#10264 review). The released cut
 * must equal the resident cut of the same copies.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StoreApi } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { MeshData } from '@ifc-lite/geometry';
import { Drawing2DGenerator, createSectionConfig } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { carryReleasedMesh } from '@/lib/released-mesh-provenance';
import { placedMesh } from '@/lib/model-placement/placed-geometry';
import { geometryBackingCommand } from './backing-debug-hook';
import type { TapState } from './store-backing-tap';
import { withCutGeometry } from './cut-readback';
import { withInstancedMeshes, withReleasedExportGeometry } from '@/utils/instancedExport';

/** A closed unit box at (x, 0, z): its cut at y = 0.5 is one square. */
function box(expressId: number, x: number, z: number): MeshData {
  const p: number[] = [];
  for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]) p.push(x + dx, dy, z + dz);
  const indices = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0];
  return { expressId, ifcType: 'IfcWall', positions: Float32Array.from(p), normals: new Float32Array(p.length),
    indices: Uint32Array.from(indices), color: [1, 1, 1, 1] };
}

async function cut(meshes: readonly MeshData[]): Promise<string[]> {
  const config = createSectionConfig('y', 0.5, { projectionDepth: 0, includeHiddenLines: false });
  const generator = new Drawing2DGenerator();
  await generator.initialize();
  const drawing = await withCutGeometry(meshes, config.plane, 0, (input) => generator.generate(input as MeshData[], config,
    { includeHiddenLines: false, includeProjection: false, includeEdges: false, mergeLines: true }));
  return drawing.cutPolygons.map((p) => `${p.entityId}:${p.polygon.outer.map((q) => `${q.x.toFixed(4)},${q.y.toFixed(4)}`).join(' ')}`).sort();
}

describe('section caps over released federated, placed geometry', () => {
  it('cuts the copies consumers pass exactly as while resident', async () => {
    const a = [box(1, 0, 0), box(2, 3, 0)], b = [box(1001, 0, 5)];
    useViewerStore.setState({ models: new Map([
      ['A', { id: 'A', idOffset: 0, maxExpressId: 100, geometryResult: { meshes: a } }],
      ['B', { id: 'B', idOffset: 1000, maxExpressId: 100, geometryResult: { meshes: b } }],
    ]) } as never);
    const store = useViewerStore as unknown as StoreApi<TapState>;
    try {
      await geometryBackingCommand(store, undefined, { action: 'start',
        options: { chunkBytes: 64, queueBytes: 4096, database: { name: `cut-federated-${process.pid}`, locks: null } } as never });
      await geometryBackingCommand(store, undefined, { action: 'seal' });
      // What the cap hook receives: re-homed federation copies, then model B translated 10 m in x.
      const consumerInput = () => [
        ...a.map((m) => carryReleasedMesh(m, { ...m, modelIndex: 0 })),
        ...b.map((m) => placedMesh(carryReleasedMesh(m, { ...m, modelIndex: 1 }), [10, 0, 0])),
      ];
      const heldCopies = consumerInput();
      const resident = await cut(heldCopies);
      assert.equal(resident.length, 3);
      releaseCpuMeshBuffers([...a, ...b]);
      assert.ok(heldCopies.every((mesh) => mesh.positions.length === 0), 'registered copies release their buffers too');
      const released = await cut(heldCopies);
      assert.deepEqual(released, resident, 'same polygons, including the translated federated model');
      // The export collectors (Cesium, GLB, KMZ) receive the same kind of copies.
      const input = heldCopies;
      const exported = await withReleasedExportGeometry(() => withInstancedMeshes(
        { meshes: input, totalTriangles: 36, totalVertices: 24, coordinateInfo: {} as never }, null));
      assert.deepEqual(exported.meshes.map((m) => [m.expressId, m.modelIndex, m.origin ?? null, m.positions.length]),
        input.map((m) => [m.expressId, m.modelIndex, m.origin ?? null, 24]));
    } finally {
      await geometryBackingCommand(store, undefined, { action: 'stop' });
    }
  });
});

it('#10887 extra caps read a released legacy geometryResult with no models', async () => {
  const initial = useViewerStore.getState();
  const meshes = [box(42, 0, 0)];
  const geometry = { meshes };
  const store = createStore<TapState>(() => ({
    models: new Map([['__legacy__', { geometryResult: geometry }]]), geometryContentVersion: 0,
  }));
  useViewerStore.setState({ models: new Map(), geometryResult: geometry } as never);
  try {
    await geometryBackingCommand(store, undefined, { action: 'start', options: {
      database: { name: `legacy-cap-${process.pid}`, locks: null },
    } as never });
    await geometryBackingCommand(store, undefined, { action: 'seal' });
    const resident = await cut(meshes);
    assert.equal(resident.length, 1);
    releaseCpuMeshBuffers(meshes);
    assert.deepEqual(await cut(meshes), resident, 'the complete legacy backing answers the cap');
  } finally {
    await geometryBackingCommand(store, undefined, { action: 'stop' });
    useViewerStore.setState(initial, true);
  }
});
