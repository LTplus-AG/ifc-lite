/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A streamed IFC is resident in the Scene ONCE, whatever joins it afterwards
 * and in whichever order (#6953).
 *
 * The streaming fast path appends `geometry.slice(lastLength)` and never
 * records the per-mesh keys the non-streaming "unprocessed meshes" scan
 * consults. When a render leaves the merged geometry length unchanged but
 * the camera unfitted, the hook falls through towards its camera-fit block
 * and on the way runs that scan, which then sees every streamed mesh as new
 * and uploads it a second time. Two real triggers:
 *   - a model without meshes (a point-cloud scan) joins after the IFC: the
 *     model count rises, which unfits the camera for a refit, and the merged
 *     array is rebuilt with the same length;
 *   - an IFC whose bounds are unknown while it streams (#859): the camera
 *     cannot fit mid-stream, so the streaming-complete render is the first
 *     to fit it.
 * Invariant: the Scene's triangle total equals the store's, independent of
 * load order.
 */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useMemo, useRef, useState } from 'react';
import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { Camera } from '../../../../../packages/renderer/src/camera.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices.js';
import { appearanceInstanceScene } from '@/test/appearance-instance-scene.js';
import { cleanup, render, waitFor } from '@/test/render.js';
import { useFederatedGeometry } from './useFederatedGeometry.js';
import { useGeometryStreaming } from './useGeometryStreaming.js';
import { useFilteredGeometry } from './useFilteredGeometry.js';

let setStreaming: (streaming: boolean) => void = () => {};

function Viewport({ renderer }: { renderer: Renderer }) {
  const s = useViewerStore();
  const [isStreaming, set] = useState(false);
  setStreaming = set;
  const indices = useMemo(() => modelIndices(s.models), [s.models]);
  const geometry = useFederatedGeometry(s.models, s.geometryResult, indices, s.geometryContentVersion);
  const filtered = useFilteredGeometry(geometry, s.geometryContentVersion, s.typeVisibility, s.typeViewMode);
  const rendererRef = useRef<Renderer | null>(renderer);
  const geometryBoundsRef = useRef({ min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } });
  const clearColorRef = useRef<[number, number, number, number]>([0, 0, 0, 1]);
  useGeometryStreaming({ rendererRef, geometry: filtered.filteredGeometry,
    appearanceSourceGeometry: geometry?.meshes, coordinateInfo: geometry?.coordinateInfo,
    geometryVersion: filtered.geometryVersion, geometryContentVersion: s.geometryContentVersion,
    geometryReplacementVersion: filtered.geometryReplacementVersion,
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

const IFC_ELEMENTS = 6;
const IFC_TRIANGLES = IFC_ELEMENTS * 2;

/** One quad (two triangles) per element, laid out along +X. */
function ifcMeshes(n = IFC_ELEMENTS): MeshData[] {
  return Array.from({ length: n }, (_, i) => {
    const x = i * 2;
    const positions = new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0, x + 1, 1, 0]);
    return {
      expressId: 10 + i, positions, normals: new Float32Array(12), indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
      color: [0.5, 0.5, 0.5, 1], ifcType: 'IfcWall',
    } as MeshData;
  });
}

const box = (x: number, y: number) => ({ min: { x: 0, y: 0, z: 0 }, max: { x, y, z: 0 } });

function coordinateInfo(knownBounds: boolean): CoordinateInfo {
  // The wasm bridge ships an all-zero placeholder before real bounds exist.
  const bounds = knownBounds ? box(11, 1) : box(0, 0);
  return { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false };
}

function model(id: string, meshes: MeshData[], extra: Partial<FederatedModel> = {}, knownBounds = true): FederatedModel {
  return {
    id, name: id, visible: true, idOffset: 0, maxExpressId: 100,
    geometryResult: { meshes, totalVertices: 0, totalTriangles: meshes.reduce((t, m) => t + m.indices.length / 3, 0),
      coordinateInfo: coordinateInfo(knownBounds) },
    ...extra,
  } as unknown as FederatedModel;
}

/** A model that contributes no meshes, as a LAS/LAZ/COPC scan registers. */
const scan = () => model('scan', [], { pointCloudHandleId: 7 } as Partial<FederatedModel>);

function sceneTriangles(scene: ReturnType<typeof appearanceInstanceScene>['scene']): number {
  let triangles = 0;
  scene.forEachMeshData((mesh) => { triangles += mesh.indices.length / 3; });
  return triangles;
}

function mount() {
  const native = appearanceInstanceScene([]);
  const camera = new Camera();
  const renderer = { getScene: () => native.scene, getGPUDevice: () => native.device, getPipeline: () => native.pipeline,
    getCamera: () => camera, getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
    clearCaches() {}, requestRender() {} } as unknown as Renderer;
  render(<Viewport renderer={renderer} />);
  return { ...native, camera };
}

type Native = ReturnType<typeof mount>;
const flush = (native: Native) => native.scene.flushPending(native.device, native.pipeline, Infinity);

// #7047: renderer vertices must follow immutable replacement, even with the
// same IDs and count. Growing replacements must not be mistaken for appends.
for (const federated of [false, true]) {
  for (const growth of [0, 1]) {
  it(`${growth ? 'growing' : 'same-count'} replacement uploads new vertices (${federated ? 'federated' : 'single model'}, #7047)`, async () => {
    const native = mount();
    const others = federated ? [model('other', ifcMeshes(1))] : [];
    await streamIfc(native, others);
    await waitFor(() => !native.scene.hasStreamingFragments(), 'initial streamed geometry finalized');
    assert.equal(sceneTriangles(native.scene), IFC_TRIANGLES + others.length * 2);
    const pose = { position: { ...native.camera.getPosition() }, target: { ...native.camera.getTarget() } };
    const replacement = ifcMeshes(IFC_ELEMENTS + growth).map(mesh => ({ ...mesh,
      positions: Float32Array.from(mesh.positions, (v, i) => i % 3 === 0 ? v + 50 : v) }));
    await act(async () => {
      useViewerStore.getState().updateModel('ifc', { geometryResult: model('ifc', replacement).geometryResult });
    });
    flush(native);
    const positions: number[] = [];
    native.scene.forEachMeshData(mesh => { positions.push(mesh.positions[0]); });
    assert.equal(positions.filter(x => x >= 50).length, IFC_ELEMENTS + growth,
      'all replacement meshes must reach the real renderer Scene');
    assert.equal(sceneTriangles(native.scene), (IFC_ELEMENTS + growth + others.length) * 2,
      'the replacement must not leave the old meshes resident');
    assert.deepEqual({ position: native.camera.getPosition(), target: native.camera.getTarget() }, pose,
      'replacing an existing model preserves the fitted camera');
  });
  }
}

/** Stream the IFC into the store two meshes per batch, as the loader does,
 * alongside any models already open, then end streaming. */
async function streamIfc(native: Native, others: FederatedModel[] = [], knownBounds = true) {
  const meshes = ifcMeshes();
  const models = (end: number) => new Map([...others.map((m) => [m.id, m] as const),
    ['ifc', model('ifc', meshes.slice(0, end), {}, knownBounds)] as const]);
  await act(async () => { setStreaming(true); });
  for (let end = 2; end <= meshes.length; end += 2) {
    await act(async () => { useViewerStore.setState({ models: models(end) }); });
  }
  flush(native);
  await act(async () => { setStreaming(false); });
  flush(native);
  return models(meshes.length);
}

it('a streamed IFC stays resident once when a mesh-less scan joins after it', async () => {
  const native = mount();
  const models = await streamIfc(native);
  assert.equal(sceneTriangles(native.scene), IFC_TRIANGLES, 'the streamed IFC is resident once');
  await act(async () => { useViewerStore.setState({ models: new Map([...models, ['scan', scan()]]) }); });
  flush(native);
  assert.equal(sceneTriangles(native.scene), IFC_TRIANGLES, 'adding a mesh-less model must not upload the IFC again');
});

it('the same IFC and scan loaded in the opposite order hold the same triangles', async () => {
  const native = mount();
  await act(async () => { useViewerStore.setState({ models: new Map([['scan', scan()]]) }); });
  await streamIfc(native, [scan()]);
  assert.equal(sceneTriangles(native.scene), IFC_TRIANGLES);
});

it('a streamed IFC whose bounds were unknown mid-stream is resident once after streaming ends (#859 path)', async () => {
  const native = mount();
  await streamIfc(native, [], false);
  assert.equal(sceneTriangles(native.scene), IFC_TRIANGLES,
    'the streaming-complete camera fit must not re-upload the streamed meshes');
});
