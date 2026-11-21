/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #10264: a scene snapshot holds every mesh, so a reopen that adopts it draws
// spaces and openings before its meshes decode. The snapshot carries its type
// index, and the viewport hides those ids under the CURRENT toggles before the
// first frame. Driven through the real renderer Scene: cold stream, capture,
// stored entry, adoption, with the mesh decode held back.
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Renderer, RenderPipeline, SceneSnapshot } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { encodeSceneSnapshot } from '@ifc-lite/renderer';
import { Scene } from '../../../../packages/renderer/src/scene.js';
import { useViewerStore } from '../store/index.js';
import { clearCache } from '../services/ifc-cache.js';
import { noteFinalFitBounds, sceneSnapshotKey, takeSceneSnapshotGeometry } from '../components/viewer/sceneSnapshotOwnership.js';
import { useFilteredGeometry } from '../components/viewer/useFilteredGeometry.js';
import { cleanup, render } from '../test/render.js';
import { entryOf, immediateIdle, putSnapshots, restoreIdle, snapshotTrace, storedSnapshot, until } from '../test/scene-snapshot-fixture.js';
import { abandonAdoptedSceneSnapshot, adoptCachedSceneSnapshot, armColdSceneCapture } from './sceneSnapshotLoad.js';
import { setGlobalRendererRef } from './useBCF.js';

(globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8, COPY_SRC: 4, STORAGE: 128 };

const BOUNDS = { min: { x: 0, y: 0, z: 0 }, max: { x: 9, y: 2, z: 1 } };
const WALL = 1, SPACE = 2, WALL2 = 3, OPENING = 4;

function triangle(expressId: number, x: number, ifcType: string, color: [number, number, number, number]): MeshData {
  return { expressId, modelIndex: 0, ifcType, color, positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) } as MeshData;
}
const arrival = () => [triangle(WALL, 0, 'IfcWall', [1, 0, 0, 1]), triangle(SPACE, 2, 'IfcSpace', [0, 0, 1, 0.3]),
  triangle(WALL2, 4, 'IfcWall', [1, 0, 0, 1]), triangle(OPENING, 6, 'IfcOpeningElement', [1, 0.5, 0.5, 0.3])];

const device = {
  limits: { maxBufferSize: 1 << 28 },
  createBuffer: ({ usage }: { usage: number }) => ({ usage, destroy() {} }),
  createBindGroup: () => ({}),
  createCommandEncoder: () => ({ copyBufferToBuffer: () => {}, finish: () => ({}) }),
  queue: { writeBuffer: () => {}, submit: () => {} },
} as unknown as GPUDevice;
const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;
const refs = () => ({ lastGeometryLengthRef: { current: 0 }, lastGeometryRef: { current: null }, cameraFittedRef: { current: false },
  finalBoundsRefittedRef: { current: false }, geometryBoundsRef: { current: BOUNDS }, cameraSnapshotRef: { current: null } });

function realScene(): Scene {
  const scene = new Scene();
  scene.setQuantizedBatches(true);
  return scene;
}

/** The renderer surface capture and adoption read; `frames` records the type-hidden ids each paint request saw. */
function rendererFor(scene: Scene, onPaint: () => void = () => {}): Renderer {
  const camera = { getSceneBounds: () => BOUNDS, getOrbitAnchorBounds: () => null, reset() {}, fitBoundsAdaptive() {}, setSceneBounds() {}, setOrbitAnchorBounds() {} };
  return { getGPUDevice: () => device, getPipeline: () => pipeline, getScene: () => scene, getCamera: () => camera,
    getCanvas: () => null, clearCaches() {}, requestRender: onPaint, enableQuantizedBatches: async () => {} } as unknown as Renderer;
}

/** A cold load of `arrival()`, captured, written and stored; resolves the stored snapshot. */
async function capturedEntry(key: string): Promise<SceneSnapshot> {
  const scene = realScene();
  const { trace, outcomes } = snapshotTrace();
  const capture = armColdSceneCapture(() => false, trace, 'm1');
  const meshes = arrival();
  takeSceneSnapshotGeometry(meshes, 0, rendererFor(scene), refs() as never, true);
  scene.clearFlatGeometry();
  scene.queueMeshes(meshes);
  scene.flushPending(device, pipeline, 1000);
  await scene.finalizeStreamingAsync(device, pipeline);
  capture.entryWritten(await entryOf(key));
  useViewerStore.setState({ loading: false });
  await until(() => outcomes().length > 0, 'the snapshot write');
  assert.deepEqual(outcomes(), ['written']);
  return (await storedSnapshot(key)) as SceneSnapshot;
}

/** The viewport's type-hidden ids as ViewportContainer derives them, with the mesh list still empty (decode held back). */
let viewportHidden: number[] = [];
function Viewport() {
  const s = useViewerStore();
  viewportHidden = [...useFilteredGeometry(null, 0, s.typeVisibility, s.typeViewMode).typeHidden.ids].sort((a, b) => a - b);
  return null;
}

const gpu = (globalThis.navigator as unknown as { gpu?: unknown });
beforeEach(async () => {
  putSnapshots.clear();
  await clearCache();
  noteFinalFitBounds(BOUNDS as never);
  gpu.gpu = {};
  useViewerStore.setState({ loading: true, geometryStreamingActive: false, appliedEntityLevelOffsets: new Map() });
  immediateIdle();
});
afterEach(() => {
  cleanup();
  restoreIdle();
  delete gpu.gpu;
  setGlobalRendererRef({ current: null });
  useViewerStore.setState({ loading: false, geometryStreamingActive: false, appliedEntityLevelOffsets: new Map() });
});

async function reopen(snapshot: SceneSnapshot, onPaint: () => void) {
  const scene = realScene();
  setGlobalRendererRef({ current: rendererFor(scene, onPaint) });
  const blob = new Blob([encodeSceneSnapshot(snapshot)]);
  const cacheResult = { buffer: new Blob([new Uint8Array(64)]), sceneSnapshot: blob, sceneSnapshotKey: sceneSnapshotKey(scene.sceneSnapshotPolicy()) };
  const { trace } = snapshotTrace();
  let adopted: Awaited<ReturnType<typeof adoptCachedSceneSnapshot>> = null;
  await act(async () => { adopted = await adoptCachedSceneSnapshot(cacheResult as never, 'm1', undefined, trace); });
  return { scene, adopted: adopted as Awaited<ReturnType<typeof adoptCachedSceneSnapshot>> };
}

describe('scene snapshot type index (#10264)', () => {
  for (const [captured, reopened] of [[false, false], [true, false], [false, true]] as const) {
    it(`hides the classes the toggles hide NOW in the first adopted frame (spaces ${captured ? 'shown' : 'hidden'} at capture, ${reopened ? 'shown' : 'hidden'} at reopen)`, async () => {
      const set = (spaces: boolean) => useViewerStore.setState((s) => ({ typeVisibility: { ...s.typeVisibility, spaces, openings: false } }));
      set(captured);
      const snapshot = await capturedEntry(`k-${captured}-${reopened}`);
      assert.ok((snapshot.hostData as { typeIndex?: unknown }).typeIndex, 'the stored snapshot carries its type index');
      set(reopened);
      render(<Viewport />);
      assert.deepEqual(viewportHidden, [], 'nothing published, nothing installed yet');
      const paints: number[][] = [];
      const { scene, adopted } = await reopen(snapshot, () => paints.push([...viewportHidden]));
      assert.ok(adopted, 'adopted');
      assert.equal(scene.isSceneSnapshotHydrating(), true, 'its meshes have not been published (decode held back)');
      const expected = reopened ? [OPENING] : [SPACE, OPENING];
      assert.ok(paints.length > 0, 'adoption asked for a frame');
      assert.deepEqual(paints[0], expected, 'the first frame already hides what the current toggles hide');
      // A toggle inside the window applies at once, from the stored index.
      act(() => useViewerStore.getState().toggleTypeVisibility('openings'));
      assert.deepEqual(viewportHidden, reopened ? [] : [SPACE]);
      act(() => abandonAdoptedSceneSnapshot(adopted));
      assert.deepEqual(viewportHidden, [], 'an ended load stops hiding by its stored index');
    });
  }

  it('does not adopt a snapshot without a type index: the hit streams instead', async () => {
    const snapshot = await capturedEntry('bare');
    const bare = { ...snapshot, hostData: { ...(snapshot.hostData as object), typeIndex: undefined } };
    render(<Viewport />);
    let paints = 0;
    const { scene, adopted } = await reopen(bare, () => { paints++; });
    assert.equal(adopted, null);
    assert.equal(scene.isSceneSnapshotHydrating(), false, 'nothing was adopted');
    assert.equal(paints, 0, 'and nothing was painted');
  });

  it('does not adopt when no viewport commits the stored index', async () => {
    const snapshot = await capturedEntry('headless');
    const { scene, adopted } = await reopen(snapshot, () => {});
    assert.equal(adopted, null, 'fails closed rather than paint hidden classes');
    assert.equal(scene.isSceneSnapshotHydrating(), false);
  });
});
