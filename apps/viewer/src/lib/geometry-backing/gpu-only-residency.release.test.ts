/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU-only residency against the real backing: the viewer store, the real tap
 * (IndexedDB) and the real verified release. Only the renderer and the
 * settled-scene wait are stand-ins.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StoreApi } from 'zustand';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { existsSync } from 'node:fs';
import type { GpuOnlyState } from './gpu-only-residency';

// Loaded after asserting the modules exist, so a reverted change fails on an assertion rather than as
// a file that cannot load.
async function load() {
  for (const file of ['gpu-only-mode.ts', 'gpu-only-residency.ts', 'active-backing.ts']) {
    assert.ok(existsSync(new URL(`./${file}`, import.meta.url)), `lib/geometry-backing/${file} must exist`);
  }
  return { ...await import('./gpu-only-mode'), ...await import('./gpu-only-residency'), ...await import('./active-backing') };
}

function mesh(expressId: number, z: number): MeshData {
  return { expressId, ifcType: 'IfcWall', positions: Float32Array.from([0, 0, z, 1, 0, z, 0, 1, z]),
    normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] };
}

/** A renderer whose scene releases when asked, as the viewport's does once its stream has finalized. */
function fakeRenderer() {
  let released = false;
  const renderer = {
    getScene: () => ({ releaseGeometryData: () => { released = true; }, isGeometryDataReleased: () => released }),
    setReleasedSceneRebuild: () => undefined,
  } as unknown as Renderer;
  return { renderer, sceneReleased: () => released };
}

async function run(name: string, beforeSettle?: () => void, scenario?: 'reload' | 'replace-during-seal') {
  const { GpuOnlyResidency, geometryBackingInUse, releaseVerifiedGeometry, runningGeometryBacking, startGeometryBacking, stopGeometryBacking } = await load();
  const store = useViewerStore as unknown as StoreApi<GpuOnlyState>;
  useViewerStore.setState({ models: new Map(), geometryResult: null, removedMeshes: new Map(), boundedGeometryMode: false } as never);
  const { renderer, sceneReleased } = fakeRenderer();
  let settled: ((ok: boolean) => void) | null = null;
  const replacementMeshes = [mesh(3, 8)];
  const controller = new GpuOnlyResidency(store, {
    requested: () => true,
    tapInUse: geometryBackingInUse,
    startTap: (target) => startGeometryBacking(target, { database: { name, locks: null } } as never),
    stopTap: stopGeometryBacking,
    release: async (tap, target, renderer) => {
      if (scenario === 'replace-during-seal') {
        const seal = tap.seal.bind(tap);
        tap.seal = async () => {
          tap.seal = seal;
          useViewerStore.setState({ models: new Map(), geometryResult: null } as never);
          const geometryResult: GeometryResult = { meshes: replacementMeshes, totalTriangles: 1, totalVertices: 3,
            coordinateInfo: {} as GeometryResult['coordinateInfo'] };
          useViewerStore.setState({ models: new Map([['m', { id: 'm', idOffset: 0, maxExpressId: 10,
            geometryResult, fileSize: 1, loadState: 'complete' }]]) } as never);
          return seal();
        };
      }
      return releaseVerifiedGeometry(tap, target, renderer);
    },
    renderer: () => renderer,
    whenSettled: (done) => { settled = done; return () => { settled = null; }; },
    now: () => performance.now(),
  });
  const uninstall = controller.install();
  async function loadModel() {
    // The loader's order: a placeholder, then the streamed geometry, then completion.
    useViewerStore.setState({ models: new Map([['m', { id: 'm', idOffset: 0, maxExpressId: 10, geometryResult: null, fileSize: 1, loadState: 'pending' }]]) } as never);
    const meshes = [mesh(1, 0), mesh(2, 4)];
    const geometryResult: GeometryResult = { meshes, totalTriangles: 2, totalVertices: 6, coordinateInfo: {} as GeometryResult['coordinateInfo'] };
    useViewerStore.setState({ models: new Map([['m', { id: 'm', idOffset: 0, maxExpressId: 10, geometryResult, fileSize: 1, loadState: 'complete' }]]) } as never);
    beforeSettle?.();
    assert.ok(settled, 'the controller waits for the scene once the load completed');
    (settled as (ok: boolean) => void)(true);
    settled = null;
    const deadline = Date.now() + 10_000;
    while (!['released', 'failed', 'cancelled'].includes(controller.status().phase) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    return meshes;
  }
  const firstMeshes = await loadModel();
  if (scenario === 'reload') {
    assert.equal(controller.status().phase, 'released', controller.status().error ?? 'not released');
    assert.deepEqual(firstMeshes.map((mesh) => mesh.positions.length), [0, 0]);
    useViewerStore.setState({ models: new Map(), geometryResult: null } as never);
  }
  const meshes = scenario === 'reload' ? await loadModel() : firstMeshes;
  return { controller, meshes, replacementMeshes, sceneReleased, uninstall, runningGeometryBacking, stopGeometryBacking };
}

describe('GPU-only residency against the real backing', () => {
  it('releases the store and the scene once the backing of the streamed model verifies', async () => {
    const { controller, meshes, sceneReleased, uninstall, runningGeometryBacking, stopGeometryBacking } = await run(`gpu-only-ok-${process.pid}`);
    try {
      assert.equal(controller.status().phase, 'released', controller.status().error ?? 'not released');
      assert.equal(sceneReleased(), true);
      assert.deepEqual(meshes.map((m) => [m.positions.length, m.normals.length, m.indices.length]), [[0, 0, 0], [0, 0, 0]]);
      const tap = await runningGeometryBacking();
      assert.ok(tap, 'the backing is the only copy now: its tap keeps running');
      assert.equal(tap.status().every((row) => row.complete), true);
      assert.equal(useViewerStore.getState().boundedGeometryMode, false, 'the mode ends with the load it was set for');
    } finally {
      uninstall();
      const tap = await runningGeometryBacking();
      if (tap) await stopGeometryBacking(tap);
    }
  });

  it('#11512: backs and releases a reload through the same tap after the previous model closes', async () => {
    const { controller, meshes, uninstall, runningGeometryBacking, stopGeometryBacking } = await run(
      `gpu-only-reload-${process.pid}`, undefined, 'reload',
    );
    try {
      assert.equal(controller.status().phase, 'released', controller.status().error ?? 'not released');
      assert.deepEqual(meshes.map((mesh) => mesh.positions.length), [0, 0]);
    } finally {
      uninstall();
      const tap = await runningGeometryBacking();
      if (tap) await stopGeometryBacking(tap);
    }
  });

  it('#11512: a release awaiting its seal leaves a same-ID replacement resident', async () => {
    const { controller, meshes, replacementMeshes, sceneReleased, uninstall, runningGeometryBacking, stopGeometryBacking } = await run(
      `gpu-only-replacement-${process.pid}`, undefined, 'replace-during-seal',
    );
    try {
      assert.equal(controller.status().phase, 'failed');
      assert.equal(sceneReleased(), false);
      assert.deepEqual(meshes.map((mesh) => mesh.positions.length), [9, 9]);
      assert.deepEqual(replacementMeshes.map((mesh) => mesh.positions.length), [9]);
    } finally {
      uninstall();
      const tap = await runningGeometryBacking();
      if (tap) await stopGeometryBacking(tap);
    }
  });

  it('releases nothing when the store holds geometry the backing does not cover', async () => {
    // A delete-undo stash is CPU geometry outside every backed list: the allowlist refuses.
    const { controller, meshes, sceneReleased, uninstall, runningGeometryBacking } = await run(`gpu-only-refused-${process.pid}`, () => {
      useViewerStore.setState({ removedMeshes: new Map([['x', { meshes: [mesh(9, 9)] }]]) } as never);
    });
    try {
      assert.equal(controller.status().phase, 'failed');
      assert.match(controller.status().error ?? '', /not backed; nothing was released/);
      assert.equal(sceneReleased(), false);
      assert.deepEqual(meshes.map((m) => m.positions.length), [9, 9], 'the arrays are untouched');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(await runningGeometryBacking(), undefined, 'the tap this load started was stopped');
      assert.equal(useViewerStore.getState().boundedGeometryMode, false);
    } finally {
      uninstall();
    }
  });
});
