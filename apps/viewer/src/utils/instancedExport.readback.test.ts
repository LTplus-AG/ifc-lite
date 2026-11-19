/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Exports over released CPU geometry (#10264): `withInstancedMeshes` must give
 * the same flat meshes and instanced occurrences from the backing, and must
 * refuse rather than export empty arrays outside the read-back context.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RefObject } from 'react';
import type { StoreApi } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { setGlobalRendererRef } from '../hooks/useBCF.js';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { enqueueInstancedShards, instancedShardGeneration } from '@/store/instancedShardQueue';
import { geometryBackingCommand } from '@/lib/geometry-backing/backing-debug-hook';
import type { TapState } from '@/lib/geometry-backing/store-backing-tap';
import { GeometryUnavailableError } from '@/lib/geometry-backing/geometry-readback';
import { withInstancedMeshes, withReleasedExportGeometry } from './instancedExport.js';

function mesh(expressId: number, z: number): MeshData {
  return { expressId, ifcType: 'IfcWall', positions: Float32Array.from([0, 0, z, 1, 0, z, 0, 1, z]),
    normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] };
}

/** IFNS v1: one template triangle, one occurrence of `entityId`. */
function shardBytes(entityId: number): ArrayBuffer {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0], normals = [0, 0, 1, 0, 0, 1, 0, 0, 1], indices = [0, 1, 2];
  const dataOffset = 32 + 48 + 88;
  const buffer = new ArrayBuffer(dataOffset + (positions.length + normals.length + indices.length) * 4);
  const view = new DataView(buffer);
  [0x4946_4e53, 1, 1, 1, positions.length, normals.length, indices.length, 0].forEach((w, i) => view.setUint32(i * 4, w, true));
  [0, 9, 0, 9, 0, 3].forEach((w, i) => view.setUint32(32 + i * 4, w, true));
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

describe('exports over released geometry', () => {
  it('reads flat meshes and instanced occurrences back, and refuses outside the context', async () => {
    const meshes = [mesh(1, 0), mesh(2, 3)];
    const bytes = meshes.map((m) => [...m.positions]);
    const geometryResult: GeometryResult = { meshes, totalTriangles: 2, totalVertices: 6,
      coordinateInfo: {} as GeometryResult['coordinateInfo'] };
    useViewerStore.setState({ models: new Map([['exp', { id: 'exp', idOffset: 0, maxExpressId: 100, geometryResult }]]) } as never);
    const store = useViewerStore as unknown as StoreApi<TapState>;
    let released = false;
    const scene = {
      isGeometryDataReleased: () => released,
      placeAppearanceSource: (m: MeshData) => ({ ...m }),
      getAllInstancedMeshData: () => [] as MeshData[],
    };
    setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer } as RefObject<Renderer | null>);
    try {
      await geometryBackingCommand(store, undefined, { action: 'start', options: { database: { name: `export-readback-${process.pid}`, locks: null } } as never });
      enqueueInstancedShards('exp', [shardBytes(77)], instancedShardGeneration());
      const [status] = await geometryBackingCommand(store, undefined, { action: 'seal' }) as Array<{ complete: boolean }>;
      assert.equal(status.complete, true);
      const range = { modelId: 'exp', idOffset: 0, maxExpressId: 100 };
      // Release as the test-only command would: scene and store together.
      released = true;
      releaseCpuMeshBuffers(meshes);
      assert.throws(() => withInstancedMeshes(geometryResult, range), GeometryUnavailableError,
        'never an export of emptied arrays');
      const exported = await withReleasedExportGeometry(() => withInstancedMeshes(geometryResult, range));
      assert.deepEqual(exported.meshes.slice(0, 2).map((m) => [...m.positions]), bytes, 'exact flat geometry');
      const occurrence = exported.meshes.find((m) => m.expressId === 77);
      assert.ok(occurrence, 'the instanced occurrence is exported');
      assert.equal(exported.totalTriangles, 3);
      assert.throws(() => withInstancedMeshes(geometryResult, range), GeometryUnavailableError, 'the context ends with the export');
    } finally {
      await geometryBackingCommand(store, undefined, { action: 'stop' });
      setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
    }
  });

  it('runs resident exports directly', async () => {
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
    const geometryResult: GeometryResult = { meshes: [mesh(1, 0)], totalTriangles: 1, totalVertices: 3,
      coordinateInfo: {} as GeometryResult['coordinateInfo'] };
    useViewerStore.setState({ models: new Map([['res', { id: 'res', idOffset: 0, maxExpressId: 10, geometryResult }]]) } as never);
    const out = await withReleasedExportGeometry(() => withInstancedMeshes(geometryResult, null));
    assert.equal(out.meshes[0], geometryResult.meshes[0]);
  });

  it('#10887 exporting the current geometry ignores a pending model with no geometry', async () => {
    const geometry: GeometryResult = { meshes: [mesh(1, 7)], totalTriangles: 1, totalVertices: 3,
      coordinateInfo: {} as GeometryResult['coordinateInfo'] };
    useViewerStore.setState({ models: new Map([['ready', {
      id: 'ready', idOffset: 0, maxExpressId: 10, geometryResult: geometry,
    }]]) } as never);
    const store = useViewerStore as unknown as StoreApi<TapState>;
    const scene = { isGeometryDataReleased: () => true, placeAppearanceSource: (m: MeshData) => m,
      getAllInstancedMeshData: () => [] as MeshData[] };
    setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer } as RefObject<Renderer | null>);
    try {
      await geometryBackingCommand(store, undefined, { action: 'start', options: {
        database: { name: `export-pending-${process.pid}`, locks: null },
      } as never });
      const rows = await geometryBackingCommand(store, undefined, { action: 'seal' });
      assert.ok(rows.every((row) => 'complete' in row && row.complete));
      releaseCpuMeshBuffers(geometry.meshes);
      useViewerStore.setState({ models: new Map([...useViewerStore.getState().models,
        ['pending', { ...fixtureModel('pending'), geometryResult: null }],
      ]) });
      let result: GeometryResult | undefined;
      await assert.doesNotReject(async () => {
        result = await withReleasedExportGeometry(() => withInstancedMeshes(geometry, null));
      }, 'a model with no geometry must not block the current view export');
      assert.ok(result);
      assert.equal(result.meshes.length, 1);
      assert.equal(result.meshes[0].positions[2], 7, 'unscoped view exporters keep the ready model');
    } finally {
      await geometryBackingCommand(store, undefined, { action: 'stop' });
      setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
    }
  });

  for (const failFirst of [false, true]) {
    it(`#10887 overlapping scoped exports keep separate contexts after ${failFirst ? 'failure' : 'success'}`, async () => {
      const first: GeometryResult = { meshes: [mesh(1, 2)], totalTriangles: 1, totalVertices: 3,
        coordinateInfo: {} as GeometryResult['coordinateInfo'] };
      const second: GeometryResult = { meshes: [mesh(101, 9)], totalTriangles: 1, totalVertices: 3,
        coordinateInfo: {} as GeometryResult['coordinateInfo'] };
      const expected = second.meshes[0].positions.slice();
      useViewerStore.setState({ models: new Map([
        ['first', { id: 'first', idOffset: 0, maxExpressId: 100, geometryResult: first }],
        ['second', { id: 'second', idOffset: 100, maxExpressId: 100, geometryResult: second }],
      ]) } as never);
      const store = useViewerStore as unknown as StoreApi<TapState>;
      const scene = { isGeometryDataReleased: () => true,
        placeAppearanceSource: (m: MeshData) => m, getAllInstancedMeshData: () => [] as MeshData[] };
      setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer } as RefObject<Renderer | null>);
      let allowFirst!: () => void;
      const held = new Promise<void>((resolve) => { allowFirst = resolve; });
      let enteredFirst!: () => void;
      const entered = new Promise<void>((resolve) => { enteredFirst = resolve; });
      let settledExports: Promise<unknown> = Promise.resolve();
      try {
        await geometryBackingCommand(store, undefined, { action: 'start', options: {
          database: { name: `export-overlap-${process.pid}-${failFirst}`, locks: null },
        } as never });
        const statuses = await geometryBackingCommand(store, undefined, { action: 'seal' });
        assert.ok(statuses.every((s) => 'complete' in s && s.complete));
        releaseCpuMeshBuffers(first.meshes);
        releaseCpuMeshBuffers(second.meshes);
        const a = withReleasedExportGeometry(async () => {
          enteredFirst();
          await held;
          assert.equal(withInstancedMeshes(first, null).meshes[0].positions[2], 2);
          if (failFirst) throw new Error('first exporter failed');
        }, ['first']);
        // Attach the rejection handler before letting either exporter finish.
        const outcomeA = a.then(() => null, (error: unknown) => error);
        await entered;
        let secondEntered = false;
        const b = withReleasedExportGeometry(async () => {
          secondEntered = true;
          await Promise.resolve();
          return withInstancedMeshes(second, null);
        }, ['second']);
        settledExports = Promise.allSettled([outcomeA, b]);
        await Promise.resolve();
        assert.equal(secondEntered, false, 'the second export cannot borrow the first context');
        allowFirst();
        const [error, exported] = await Promise.all([outcomeA, b]);
        if (failFirst) assert.match(String(error), /first exporter failed/);
        else assert.equal(error, null);
        assert.deepEqual(exported.meshes[0].positions, expected, 'the second scope reads its own geometry');
        assert.throws(() => withInstancedMeshes(second, null), GeometryUnavailableError, 'no context leaks after completion');
      } finally {
        allowFirst();
        await settledExports;
        await geometryBackingCommand(store, undefined, { action: 'stop' });
        setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
      }
    });
  }
});

it('#10887 unscoped legacy exports restore released flat geometry without a renderer', async () => {
  const initial = useViewerStore.getState();
  const geometry: GeometryResult = { meshes: [mesh(42, 7)], totalTriangles: 1, totalVertices: 3,
    coordinateInfo: {} as GeometryResult['coordinateInfo'] };
  const expected = [...geometry.meshes[0].positions];
  const store = createStore<TapState>(() => ({
    models: new Map([['__legacy__', { geometryResult: geometry }]]), geometryContentVersion: 0,
  }));
  useViewerStore.setState({ models: new Map(), geometryResult: geometry, activeModelId: null });
  setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  try {
    await geometryBackingCommand(store, undefined, { action: 'start', options: {
      database: { name: `legacy-export-${process.pid}`, locks: null },
    } as never });
    await geometryBackingCommand(store, undefined, { action: 'seal' });
    releaseCpuMeshBuffers(geometry.meshes);
    let result: GeometryResult | undefined;
    await assert.doesNotReject(async () => {
      result = await withReleasedExportGeometry(() => withInstancedMeshes(geometry, null));
    }, 'view PDF and KMZ-style unscoped collectors include the legacy owner');
    assert.ok(result);
    assert.deepEqual([...result.meshes[0].positions], expected);
    assert.equal(result.totalTriangles, 1);
    assert.equal(geometry.meshes[0].positions.length, 0, 'export never restores resident store arrays');
  } finally {
    await geometryBackingCommand(store, undefined, { action: 'stop' });
    useViewerStore.setState(initial, true);
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  }
});
