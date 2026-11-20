/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10903: a released-only content reload is not triangle-count complete while
 * its released meshes are still being replayed from storage (or parked on an
 * unavailable backing). Adapted from `useGeometryStreaming.settled.test.tsx`.
 *
 * (Original harness note:) `isSceneSettled()` stays false from a stream's end until the viewport has
 * finalized it. The store stops streaming before this hook's passive effect
 * schedules the finalize, and a burst appended without the queue (the
 * small-file fast path: every mesh arrives after the store already reads "not
 * streaming") leaves no queued mesh, no fragment and no finalize in between.
 * Everything that waits for a settled scene (query index, cache entry, minimap,
 * after-load jobs) would start before the final scene.
 *
 * Real Scene with only WebGPU allocation stubbed, mounted like
 * `useGeometryStreaming.loadTrace.test.tsx`.
 */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useMemo, useRef, useState } from 'react';
import { createLoadTracer, type LoadTraceSnapshot } from '@ifc-lite/load-trace';
import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { Camera } from '../../../../../packages/renderer/src/camera.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices.js';
import { flushPlacementGeometry } from '@/lib/model-placement/bounds-revision.js';
import { publishLoadTrace } from '@/lib/perf/activeLoadTrace.js';
import { isSceneSettled } from '@/lib/scene-settled.js';
import { appearanceInstanceScene } from '@/test/appearance-instance-scene.js';
import { cleanup, render } from '@/test/render.js';
import { useFederatedGeometry } from './useFederatedGeometry.js';
import { useGeometryStreaming } from './useGeometryStreaming.js';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { releasedReplaysIdle, supersedeReleasedReplays } from '@/lib/geometry-backing/released-scene-replay';
import { setPendingSceneSnapshot, withdrawPendingSceneSnapshot } from './sceneSnapshotOwnership.js';

let setStreaming: (streaming: boolean) => void = () => {};
const adoption = {};

function Viewport({ renderer }: { renderer: Renderer }) {
  const s = useViewerStore();
  const [isStreaming, set] = useState(false);
  setStreaming = set;
  const indices = useMemo(() => modelIndices(s.models), [s.models]);
  const geometry = useFederatedGeometry(s.models, s.geometryResult, indices, s.geometryContentVersion);
  const rendererRef = useRef<Renderer | null>(renderer);
  const geometryBoundsRef = useRef({ min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } });
  const clearColorRef = useRef<[number, number, number, number]>([0, 0, 0, 1]);
  useGeometryStreaming({ rendererRef, geometry: geometry?.meshes ?? null,
    appearanceSourceGeometry: geometry?.meshes, coordinateInfo: geometry?.coordinateInfo,
    geometryVersion: s.geometryUpdateTick, geometryContentVersion: s.geometryContentVersion,
    modelCount: s.models.size, modelIdToIndex: indices,
    presentInstancedModelIndices: new Set(indices.values()), isInitialized: true, isStreaming,
    geometryBoundsRef, clearColorRef, pendingMeshColorUpdates: null, pendingColorUpdates: null,
    pendingMeshRemovals: null, pendingMeshTranslations: null, pendingMeshRotations: null,
    clearPendingMeshColorUpdates: s.clearPendingMeshColorUpdates, clearPendingColorUpdates: s.clearPendingColorUpdates,
    clearPendingMeshRemovals: s.clearPendingMeshRemovals, pruneGeometryMeshes: s.pruneGeometryMeshes,
    clearPendingMeshTranslations: s.clearPendingMeshTranslations, clearPendingMeshRotations: s.clearPendingMeshRotations });
  return null;
}

afterEach(() => {
  withdrawPendingSceneSnapshot(adoption);
  cleanup();
  useViewerStore.getState().clearAllModels();
  modelIndices(new Map());
});

function meshes(n: number, first = 10): MeshData[] {
  return Array.from({ length: n }, (_, i) => ({
    expressId: first + i, positions: new Float32Array([i * 2, 0, 0, i * 2 + 1, 0, 0, i * 2, 1, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [0.5, 0.5, 0.5, 1], ifcType: 'IfcWall',
  }) as MeshData);
}

function model(id: string, list: MeshData[], idOffset = 0): FederatedModel {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 1, z: 0 } };
  const coordinateInfo: CoordinateInfo = { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false };
  return { id, name: id, visible: true, idOffset, maxExpressId: 100,
    geometryResult: { meshes: list, totalVertices: 0, totalTriangles: list.length, coordinateInfo } } as unknown as FederatedModel;
}

function setup(withDevice = true) {
  const tracer = createLoadTracer({ enabled: true, sink: null });
  publishLoadTrace('ifc', tracer.startLoad('ifc'));
  const native = appearanceInstanceScene([]);
  const camera = new Camera();
  const renderer = { getScene: () => native.scene, getGPUDevice: () => (withDevice ? native.device : null), getPipeline: () => native.pipeline,
    getCamera: () => camera, getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
    clearCaches() {}, requestRender() {} } as unknown as Renderer;
  render(<Viewport renderer={renderer} />);
  return { tracer, native };
}


const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

it('#10903 a released-only content reload never reports triangle counts complete while its replay is parked', async () => {
  const { native } = setup();
  const calls: boolean[] = [];
  const scene = native.scene as unknown as { setTriangleCountReplayComplete?: (complete: boolean) => void };
  const original = scene.setTriangleCountReplayComplete?.bind(scene);
  scene.setTriangleCountReplayComplete = (complete: boolean) => { calls.push(complete); original?.(complete); };
  const list = meshes(3);
  await act(async () => { useViewerStore.setState({ models: new Map([['ifc', model('ifc', list)]]) }); });
  await settle();
  assert.equal(calls.at(-1), true, 'the resident load completes');
  releaseCpuMeshBuffers(list); // every mesh released; no backing is running, so the replay cannot restore them
  const errors = console.error;
  console.error = () => {};
  try {
    calls.length = 0;
    await act(async () => { useViewerStore.setState((s) => ({ geometryContentVersion: s.geometryContentVersion + 1 })); });
    await settle(1200); // three bounded attempts fail, then it parks
    assert.ok(calls.includes(false), 'the reload pass started incomplete');
    assert.notEqual(calls.at(-1), true, 'released meshes are still missing: never complete while the replay is parked');
  } finally {
    console.error = errors;
    supersedeReleasedReplays();
    await releasedReplaysIdle();
  }
});
