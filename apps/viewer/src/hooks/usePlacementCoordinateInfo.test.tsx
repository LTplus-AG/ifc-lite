/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useEffect } from 'react';
import { flushPlacementGeometry } from '@/lib/model-placement/bounds-revision';
import { Renderer } from '@ifc-lite/renderer';
import { useModelPlacementSync } from '@/components/viewer/useModelPlacementSync';
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { usePlacementCoordinateInfo } from './usePlacementCoordinateInfo';
import { resolveScanSectionPosition } from './scanSectionMath';
import { setGlobalRendererRef } from './useBCF';

afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); });
it('keeps the 2D and 3D percentage cut in the moved model extent (#4226)', () => {
  setGlobalRendererRef({ current: null });
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
  const source: CoordinateInfo = { originalBounds: bounds, shiftedBounds: bounds,
    originShift: { x: 1000, y: 0, z: 0 }, hasLargeCoordinates: true };
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), geometryResult: {
    meshes: [], totalTriangles: 0, totalVertices: 0, coordinateInfo: source,
  } }), modelPlacement: emptyPlacementState() });
  function Cut() {
    const info = usePlacementCoordinateInfo(source)!;
    const range = info.shiftedBounds;
    const viewportCut = range.min.x + 0.5 * (range.max.x - range.min.x);
    return <output>{JSON.stringify({ viewportCut, drawingCut: resolveScanSectionPosition(50, 'x', info), origin: info.originShift })}</output>;
  }
  const ui = render(<Cut />);
  act(() => { const s = useViewerStore.getState(); s.openReposition(['m']); s.previewModelTranslation([100, 0, 0]); });
  assert.deepEqual(JSON.parse(ui.textContent!), { viewportCut: 105, drawingCut: 105, origin: source.originShift });
  act(() => useViewerStore.getState().closeReposition());
  assert.equal(JSON.parse(ui.textContent!).viewportCut, 5);
});

it('refreshes section extents after a scan alignment toggle without another placement edit (#4226)', () => {
  const renderer = new Renderer(document.createElement('canvas'));
  let scanX = 100;
  renderer.getModelPlacementBounds = (_index, handle) => handle
    ? { min: { x: scanX, y: 0, z: 0 }, max: { x: scanX + 10, y: 10, z: 10 } } : null;
  setGlobalRendererRef({ current: renderer });
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
  const source: CoordinateInfo = { originalBounds: bounds, shiftedBounds: bounds,
    originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false };
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), geometryResult: {
    meshes: [], totalTriangles: 0, totalVertices: 0, coordinateInfo: source,
  } }, { ...fixtureModel('scan'), pointCloudHandleId: 7 }), pointCloudAlignmentEnabled: false,
  modelPlacement: { ...emptyPlacementState(), placements: new Map([['m', { translation: [1, 0, 0], locked: false }]]) } });
  function Cut() { return <output>{resolveScanSectionPosition(50, 'x', usePlacementCoordinateInfo(source))}</output>; }
  const ui = render(<Cut />);
  assert.equal(ui.textContent, '55.5');
  act(() => {
    useViewerStore.getState().setPointCloudAlignmentEnabled(true);
    // Mirrors PointCloudPanel: the GPU transform changes synchronously after
    // the store toggle. Bounds are queried on the subsequent React render.
    scanX = 20;
  });
  assert.equal(ui.textContent, '15.5');
});

it('refreshes section bounds after the child uploads a realigned geometry frame (#4226)', () => {
  const renderer = new Renderer(document.createElement('canvas'));
  const rendererRef = { current: renderer };
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
  const source: CoordinateInfo = { originalBounds: bounds, shiftedBounds: bounds,
    originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false };
  let uploaded = { min: { x: 1, y: 0, z: 0 }, max: { x: 11, y: 10, z: 10 } };
  renderer.getModelPlacementBounds = () => uploaded;
  setGlobalRendererRef(rendererRef);
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), geometryResult: {
    meshes: [], totalTriangles: 0, totalVertices: 0, coordinateInfo: source,
  } }), modelPlacement: { ...emptyPlacementState(), placements: new Map([['m', { translation: [1, 0, 0], locked: false }]]) } });
  const indices = new Map([['m', 0]]);
  function Upload({ geometry }: { geometry: GeometryResult }) {
    // The real viewport also uploads in a child effect, AFTER the parent has
    // rendered its section range using the preceding GPU frame's bounds.
    useEffect(() => {
      const range = geometry.coordinateInfo.shiftedBounds;
      uploaded = { min: { ...range.min, x: range.min.x + 1 }, max: { ...range.max, x: range.max.x + 1 } };
    }, [geometry]);
    useModelPlacementSync(rendererRef, true, indices, geometry);
    return null;
  }
  function View() {
    const geometry = useViewerStore((state) => state.models.get('m')!.geometryResult!);
    const info = usePlacementCoordinateInfo(geometry.coordinateInfo);
    return <><output>{resolveScanSectionPosition(50, 'x', info)}</output><Upload geometry={geometry} /></>;
  }
  const ui = render(<View />);
  assert.equal(ui.textContent, '6');
  act(() => {
    const state = useViewerStore.getState(), geometry = state.models.get('m')!.geometryResult!;
    state.updateModel('m', { geometryResult: { ...geometry, coordinateInfo: { ...source,
      shiftedBounds: { min: { x: 100, y: 0, z: 0 }, max: { x: 110, y: 10, z: 10 } } } } });
    state.bumpGeometryContentVersion();
  });
  assert.equal(ui.textContent, '106', 'upload completion invalidates the old memo without another user edit');
});

it('updates both section extents only after the queued final batch is actually flushed (#4226)', async () => {
  const renderer = new Renderer(document.createElement('canvas')), scene = renderer.getScene();
  setGlobalRendererRef({ current: renderer });
  const zero = { x: 0, y: 0, z: 0 }, source: CoordinateInfo = { originShift: zero,
    originalBounds: { min: zero, max: { x: 1, y: 1, z: 1 } }, shiftedBounds: { min: zero, max: { x: 1, y: 1, z: 1 } }, hasLargeCoordinates: false };
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), geometryResult: { meshes: [], totalTriangles: 0, totalVertices: 0, coordinateInfo: source } }),
    modelPlacement: { ...emptyPlacementState(), placements: new Map([['m', { translation: [100, 0, 0], locked: false }]]) } });
  renderer.setModelTranslation(0, [100, 0, 0]);
  const triangle = (x: number) => ({ expressId: x + 1, modelIndex: 0, positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] as [number, number, number, number] });
  (globalThis as Record<string, unknown>).GPUBufferUsage = { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8 };
  const device = { limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28 },
    createBuffer: ({ size }: GPUBufferDescriptor) => ({ size, getMappedRange: () => new ArrayBuffer(size), unmap() {}, destroy() {} }),
    queue: { writeBuffer() {} }, createBindGroup: () => ({}),
  } as unknown as GPUDevice;
  const pipeline = { getUniformBufferSize: () => 512, getBindGroupLayout: () => ({}) } as unknown as NonNullable<ReturnType<Renderer['getPipeline']>>;
  scene.queueMeshes([triangle(0)]); flushPlacementGeometry(scene, device, pipeline);
  function Cut() { const info = usePlacementCoordinateInfo(source)!; return <output>{JSON.stringify([info.shiftedBounds.max.x, resolveScanSectionPosition(50, 'x', info)])}</output>; }
  try {
    const ui = render(<Cut />); assert.deepEqual(JSON.parse(ui.textContent!), [101, 100.5]);
    scene.queueMeshes([triangle(99)]);
    assert.deepEqual(JSON.parse(ui.textContent!), [101, 100.5], 'queued data is not live yet');
    await act(async () => { await Promise.resolve(); flushPlacementGeometry(scene, device, pipeline); });
    assert.deepEqual(JSON.parse(ui.textContent!), [200, 150], 'final upload publishes the expanded extent without another store edit');
  } finally { scene.clear(); }
});
