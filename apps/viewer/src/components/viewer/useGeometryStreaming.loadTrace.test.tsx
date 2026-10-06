/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6979: the viewport side of a load reports into that load's trace. The
 * loader publishes the trace (`publishLoadTrace`); this hook, the flush
 * wrapper and the real Scene then record the streaming batches, the upload
 * slices, the camera fit, the queue drain, the refit and the post-stream
 * finalize. Real Scene with only WebGPU allocation stubbed
 * (`appearanceInstanceScene`), mounted like `useGeometryStreaming.meshlessModel.test.tsx`.
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
import { appearanceInstanceScene } from '@/test/appearance-instance-scene.js';
import { cleanup, render } from '@/test/render.js';
import { useFederatedGeometry } from './useFederatedGeometry.js';
import { useGeometryStreaming } from './useGeometryStreaming.js';

let setStreaming: (streaming: boolean) => void = () => {};

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
    pendingMeshRemovals: null, pendingMeshTranslations: null, pendingMeshRotations: null, pendingInstancedShards: null,
    clearPendingMeshColorUpdates: s.clearPendingMeshColorUpdates, clearPendingColorUpdates: s.clearPendingColorUpdates,
    clearPendingMeshRemovals: s.clearPendingMeshRemovals, pruneGeometryMeshes: s.pruneGeometryMeshes,
    clearPendingMeshTranslations: s.clearPendingMeshTranslations, clearPendingMeshRotations: s.clearPendingMeshRotations,
    clearInstancedShards: s.clearInstancedShards });
  return null;
}

afterEach(() => {
  cleanup();
  useViewerStore.getState().clearAllModels();
  modelIndices(new Map());
});

function meshes(n: number): MeshData[] {
  return Array.from({ length: n }, (_, i) => ({
    expressId: 10 + i, positions: new Float32Array([i * 2, 0, 0, i * 2 + 1, 0, 0, i * 2, 1, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [0.5, 0.5, 0.5, 1], ifcType: 'IfcWall',
  }) as MeshData);
}

function model(list: MeshData[]): FederatedModel {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 1, z: 0 } };
  const coordinateInfo: CoordinateInfo = { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false };
  return { id: 'ifc', name: 'ifc', visible: true, idOffset: 0, maxExpressId: 100,
    geometryResult: { meshes: list, totalVertices: 0, totalTriangles: list.length, coordinateInfo } } as unknown as FederatedModel;
}

const names = (snapshot: LoadTraceSnapshot | null) => (snapshot?.spans ?? []).filter((s) => s.end !== null).map((s) => s.name);
const count = (snapshot: LoadTraceSnapshot | null, name: string) => names(snapshot).filter((n) => n === name).length;

it('records the streaming batches, upload slices, camera fit, queue drain, refit and finalize on the published load (#6979)', async () => {
  const tracer = createLoadTracer({ enabled: true, sink: null });
  publishLoadTrace('ifc', tracer.startLoad('ifc'));

  const native = appearanceInstanceScene([]);
  const camera = new Camera();
  const renderer = { getScene: () => native.scene, getGPUDevice: () => native.device, getPipeline: () => native.pipeline,
    getCamera: () => camera, getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
    clearCaches() {}, requestRender() {} } as unknown as Renderer;
  render(<Viewport renderer={renderer} />);

  const all = meshes(6);
  await act(async () => { setStreaming(true); });
  for (let end = 2; end <= all.length; end += 2) {
    await act(async () => { useViewerStore.setState({ models: new Map([['ifc', model(all.slice(0, end))]]) }); });
    flushPlacementGeometry(native.scene, native.device, native.pipeline, false);
  }
  await act(async () => { setStreaming(false); });
  // startFinalize runs on a 0 ms timer; the rebuild then resolves on its own.
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  const snapshot = tracer.latest();
  assert.equal(count(snapshot, 'stream.place'), 3, 'one stream.place per streamed batch');
  assert.equal(count(snapshot, 'stream.queue'), 3, 'one stream.queue per streamed batch');
  assert.equal(count(snapshot, 'scene.flushPending'), 3, 'one scene.flushPending per uploading flush');
  for (const name of ['camera.fit', 'stream.queueDrain', 'camera.refit', 'scene.finalize']) {
    assert.equal(count(snapshot, name), 1, `${name} recorded once`);
  }
  assert.ok(names(snapshot).includes('scene.finalize.regroup'), 'the scene reports its finalize phases');
});

