/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `isSceneSettled()` stays false from a stream's end until the viewport has
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

const finalized = (snapshot: LoadTraceSnapshot | null) => (snapshot?.spans ?? []).some((s) => s.name === 'scene.finalize' && s.end !== null);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

it('a burst that arrives after the store stopped streaming (fast path): not settled until its finalize ends', async () => {
  const { tracer } = setup();
  await act(async () => { setStreaming(true); });
  await act(async () => {
    setStreaming(false);
    useViewerStore.setState({ models: new Map([['ifc', model('ifc', meshes(6))]]) });
    assert.equal(isSceneSettled(), false, 'the stream ended, the viewport has not scheduled its finalize yet');
  });
  // The meshes went straight into batches: nothing queued, no fragment, no finalize running yet.
  assert.equal(finalized(tracer.latest()), false);
  assert.equal(isSceneSettled(), false, 'appended, finalize still pending');
  await settle();
  assert.equal(finalized(tracer.latest()), true, 'the finalize ran');
  assert.equal(isSceneSettled(), true, 'settled once the finalize ended');
});

it('an ordinary streamed load settles after its finalize, as before', async () => {
  const { tracer, native } = setup();
  const all = meshes(6);
  await act(async () => { setStreaming(true); });
  for (let end = 2; end <= all.length; end += 2) {
    await act(async () => { useViewerStore.setState({ models: new Map([['ifc', model('ifc', all.slice(0, end))]]) }); });
    flushPlacementGeometry(native.scene, native.device, native.pipeline, false);
  }
  await act(async () => { setStreaming(false); });
  assert.equal(isSceneSettled(), false);
  await settle();
  assert.equal(finalized(tracer.latest()), true);
  assert.equal(isSceneSettled(), true);
});

it('a model added without a stream (a federated add) is settled at once, as before', async () => {
  setup();
  await act(async () => { useViewerStore.setState({ models: new Map([['a', model('a', meshes(3))]]) }); });
  assert.equal(isSceneSettled(), true);
  await act(async () => { useViewerStore.setState({ models: new Map([['a', model('a', meshes(3))], ['b', model('b', meshes(3, 50), 100)]]) }); });
  assert.equal(isSceneSettled(), true);
});

it('a renderer without a GPU device never holds the scene unsettled', async () => {
  setup(false);
  await act(async () => { setStreaming(true); });
  await act(async () => { setStreaming(false); useViewerStore.setState({ models: new Map([['ifc', model('ifc', meshes(6))]]) }); });
  await settle();
  assert.equal(isSceneSettled(), true, 'nothing can finalize without a device; the gate must not wait for it');
});

it('an unmounted viewport leaves nothing pending', async () => {
  setup();
  await act(async () => { setStreaming(true); });
  cleanup();
  assert.equal(isSceneSettled(), true);
});

/** An adopted scene snapshot (reopen): the scene hydrates from stored batches with the synced meshes. */
function adopt(native: ReturnType<typeof setup>['native']): { hydrated: () => number } {
  let hydrated = 0;
  const scene = native.scene as unknown as { hydrateSceneSnapshot: (a: object, m: MeshData[]) => boolean; isSceneSnapshotHydrating: () => boolean };
  scene.hydrateSceneSnapshot = () => { hydrated++; return true; };
  scene.isSceneSnapshotHydrating = () => false;
  setPendingSceneSnapshot(adoption);
  return { hydrated: () => hydrated };
}

for (const withDevice of [true, false]) {
  it(`an adopted reopen that streams its meshes settles once its stream is over, as before (${withDevice ? 'with' : 'without'} a GPU device)`, async () => {
    const { native } = setup(withDevice);
    const snapshot = adopt(native);
    await act(async () => { setStreaming(true); });
    await act(async () => { useViewerStore.setState({ models: new Map([['ifc', model('ifc', meshes(6))]]) }); });
    if (withDevice) assert.equal(snapshot.hydrated(), 1, 'the synced meshes hydrated the adopted scene');
    await act(async () => { setStreaming(false); });
    await settle();
    assert.equal(isSceneSettled(), true, 'settled, nothing left pending');
  });

  it(`an adopted reopen without a stream is settled at once, as before (${withDevice ? 'with' : 'without'} a GPU device)`, async () => {
    const { native } = setup(withDevice);
    adopt(native);
    await act(async () => { useViewerStore.setState({ models: new Map([['ifc', model('ifc', meshes(6))]]) }); });
    assert.equal(isSceneSettled(), true);
  });
}
