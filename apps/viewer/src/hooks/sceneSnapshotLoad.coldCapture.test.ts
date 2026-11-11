/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// W2 (load hillclimb, reopen lane, #9728): which loads keep their finished
// scene, when the capture is armed, and every reason one is not kept, driven
// through the real renderer Scene (queue, finalize, capture, adoption and
// hydration) on a stub GPU device.
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Renderer, RenderPipeline, SceneSnapshot } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from '../../../../packages/renderer/src/scene.js';
import { useViewerStore } from '../store/index.js';
import { clearCache } from '../services/ifc-cache.js';
import { noteFinalFitBounds, takeSceneSnapshotGeometry } from '../components/viewer/sceneSnapshotOwnership.js';
import { entryOf, immediateIdle, putSnapshots, restoreIdle, snapshotTrace, storedSnapshot, until } from '../test/scene-snapshot-fixture.js';
import { armColdSceneCapture, coldCaptureEligible, SNAPSHOT_CAPTURE_MAX_BYTES } from './sceneSnapshotLoad.js';

(globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8, COPY_SRC: 4, STORAGE: 128 };

const BOUNDS = { min: { x: 0, y: 0, z: 0 }, max: { x: 9, y: 2, z: 1 } };
const RED: [number, number, number, number] = [1, 0, 0, 1];
const BLUE: [number, number, number, number] = [0, 0, 1, 1];

function triangle(expressId: number, x: number, color = RED): MeshData {
  return { expressId, modelIndex: 0, color, positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) } as MeshData;
}
/** A cold stream's arrival order: two buckets, interleaved. */
const arrival = () => [triangle(1, 0), triangle(2, 2, BLUE), triangle(3, 4), triangle(4, 6, BLUE)];

const device = {
  limits: { maxBufferSize: 1 << 28 },
  createBuffer: ({ usage }: { usage: number }) => ({ usage, destroy() {} }),
  createBindGroup: () => ({}),
  queue: { writeBuffer: () => {} },
} as unknown as GPUDevice;
const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;

function realScene(): Scene {
  const scene = new Scene();
  scene.setQuantizedBatches(true);
  return scene;
}

/** The parts of Renderer the capture reads, around a real Scene. */
function rendererFor(scene: Scene): Renderer {
  const camera = { getSceneBounds: () => BOUNDS, getOrbitAnchorBounds: () => null };
  return { getGPUDevice: () => device, getPipeline: () => pipeline, getScene: () => scene, getCamera: () => camera } as unknown as Renderer;
}

const refs = () => ({ lastGeometryLengthRef: { current: 0 }, lastGeometryRef: { current: null }, cameraFittedRef: { current: false },
  finalBoundsRefittedRef: { current: false }, geometryBoundsRef: { current: BOUNDS }, cameraSnapshotRef: { current: null } });

/** The viewport's first sync of the load's geometry (useGeometryStreaming's new-file branch), then its stream and finalize. */
async function streamCold(scene: Scene, meshes: MeshData[]): Promise<void> {
  takeSceneSnapshotGeometry(meshes, 0, rendererFor(scene), refs() as never);
  scene.clearFlatGeometry(); // that branch's reshape, before the first piece
  scene.queueMeshes(meshes);
  scene.flushPending(device, pipeline, 1000);
  await scene.finalizeStreamingAsync(device, pipeline);
}

beforeEach(async () => {
  putSnapshots.clear();
  await clearCache();
  noteFinalFitBounds(BOUNDS as never);
  useViewerStore.setState({ loading: true, geometryStreamingActive: false, appliedEntityLevelOffsets: new Map() });
  immediateIdle();
});
afterEach(() => {
  restoreIdle();
  useViewerStore.setState({ loading: false, geometryStreamingActive: false, appliedEntityLevelOffsets: new Map() });
});

describe('coldCaptureEligible (useIfcLoader arming conditions)', () => {
  it('keeps the scene only for a primary load the cache plan writes, without textures', () => {
    assert.equal(coldCaptureEligible({ primary: true, shouldCache: true, textured: false }), true);
    assert.equal(coldCaptureEligible({ primary: false, shouldCache: true, textured: false }), false, 'a federated add never streams into the active scene');
    assert.equal(coldCaptureEligible({ primary: true, shouldCache: false, textured: false }), false, 'uncached tier: no entry to attach to');
    assert.equal(coldCaptureEligible({ primary: true, shouldCache: true, textured: true }), false, 'textured: the entry is not written');
  });
});

describe('armColdSceneCapture (W2)', () => {
  // The whole path through the real renderer, including the move from arrival order to the entry's
  // spatial-chunk order: without it the reopen's hydration refuses the snapshot (untimed GPU check #1).
  it('stores a snapshot that a reopen decoding the entry\'s order adopts and hydrates', async () => {
    const scene = realScene();
    const { trace, outcomes } = snapshotTrace();
    const capture = armColdSceneCapture(() => false, trace, 'm1');
    const meshes = arrival();
    await streamCold(scene, meshes);
    const entryOrder = [meshes[3], meshes[0], meshes[2], meshes[1]]; // as the cache writer chunked them
    capture.entryWritten({ ...(await entryOf('cold')), meshOrder: entryOrder });
    useViewerStore.setState({ loading: false });
    await until(() => outcomes().length > 0, 'the snapshot write');
    assert.deepEqual(outcomes(), ['written']);

    const reopen = realScene();
    const stored = (await storedSnapshot('cold')) as SceneSnapshot;
    const adoption = reopen.adoptSceneSnapshot(stored, device, pipeline);
    assert.ok(adoption, 'adopted');
    const decoded = entryOrder.map((m) => ({ ...m, positions: m.positions.slice(), indices: m.indices.slice() }));
    assert.equal(reopen.hydrateSceneSnapshot(adoption, decoded), true, 'hydration accepts the entry\'s order');
    assert.equal(reopen.getMeshDataPieces(4)?.length, 1);
  });

  // #9728 review: a renderer that finished starting after the first batches had already queued them
  // was never armed and left no trace. Arming now happens at the viewport's first sync of the load.
  it('arms at the viewport\'s first sync of the load\'s geometry, however late the renderer started', async () => {
    const { trace, outcomes } = snapshotTrace();
    const capture = armColdSceneCapture(() => false, trace, 'm1');
    await new Promise((r) => setTimeout(r, 30)); // no renderer yet; nothing to poll
    const scene = realScene();
    await streamCold(scene, arrival());
    capture.entryWritten(await entryOf('late'));
    useViewerStore.setState({ loading: false });
    await until(() => outcomes().length > 0, 'the snapshot write');
    assert.deepEqual(outcomes(), ['written']);
  });

  // #9728 review: an edit between the swap and the entry write (the entry is serialized from the live meshes).
  it('does not store the snapshot when a piece moved between the swap and the store', async () => {
    const scene = realScene();
    const { trace, outcomes } = snapshotTrace();
    const capture = armColdSceneCapture(() => false, trace, 'm1');
    await streamCold(scene, arrival());
    scene.translateMeshesForEntity(2, [0, 0, 5]); // gizmo move, edit card or exploded levels
    capture.entryWritten(await entryOf('moved'));
    useViewerStore.setState({ loading: false });
    await until(() => outcomes().length > 0, 'the write to end');
    assert.deepEqual(outcomes(), ['scene-changed:scene-changed']);
    assert.equal(putSnapshots.has('moved'), false);
  });

  it('does not store the snapshot when level display moved pieces after the swap', async () => {
    const scene = realScene();
    const { trace, outcomes } = snapshotTrace();
    const capture = armColdSceneCapture(() => false, trace, 'm1');
    await streamCold(scene, arrival());
    useViewerStore.setState({ appliedEntityLevelOffsets: new Map([[1, 3]]) as never });
    capture.entryWritten(await entryOf('levels'));
    useViewerStore.setState({ loading: false });
    await until(() => outcomes().length > 0, 'the write to end');
    assert.deepEqual(outcomes(), ['scene-changed:level-offsets']);
  });

  // #9728 review: a load that failed for good releases its capture at once.
  it('keeps nothing from a load that failed, even when its partial scene finalizes', async () => {
    useViewerStore.setState({ models: new Map([['m1', { loadState: 'error' }]]) as never });
    try {
      const { trace, outcomes } = snapshotTrace();
      armColdSceneCapture(() => false, trace, 'm1');
      await streamCold(realScene(), arrival());
      assert.deepEqual(outcomes(), ['not-captured:load-failed']);
    } finally {
      useViewerStore.setState({ models: new Map() as never });
    }
  });

  // #9728 review: a capture keeps one more copy of the merged geometry until it is stored.
  it('skips a capture above the byte cap', () => {
    const { trace, outcomes } = snapshotTrace();
    armColdSceneCapture(() => false, trace, 'm1');
    let onCaptured: ((s: SceneSnapshot, sources: readonly MeshData[], unchanged: () => boolean) => void) | null = null;
    const big = { getScene: () => ({ captureNextFinalize: (cb: typeof onCaptured) => { onCaptured = cb; }, sceneSnapshotPolicy: () => 'p' }),
      getCamera: () => ({ getSceneBounds: () => BOUNDS, getOrbitAnchorBounds: () => null }) } as unknown as Renderer;
    takeSceneSnapshotGeometry([], 0, big, refs() as never);
    const huge = { byteLength: SNAPSHOT_CAPTURE_MAX_BYTES + 1 } as Uint8Array;
    onCaptured!({ policy: 'p', pieceCount: 1, nextSplitId: 1, sharedFrameOrigins: [], activeBuckets: [], batches: [{ key: 'k', color: RED, vertexBytes: 0,
      expressIds: new Uint32Array(1), ordinals: new Uint32Array(1), vertexData: huge, indices: new Uint32Array(3) }] }, [], () => true);
    assert.deepEqual(outcomes(), ['not-captured:over-cap']);
  });

  it('names why an eligible cold load leaves no snapshot', async () => {
    const g = globalThis as { __IFC_LITE_SCENE_SNAPSHOT?: unknown };
    g.__IFC_LITE_SCENE_SNAPSHOT = 0;
    const off = snapshotTrace();
    try {
      armColdSceneCapture(() => false, off.trace, 'm1');
    } finally {
      delete g.__IFC_LITE_SCENE_SNAPSHOT;
    }
    assert.deepEqual(off.outcomes(), ['not-armed:snapshots-off']);

    const first = snapshotTrace();
    armColdSceneCapture(() => false, first.trace, 'm1');
    const second = snapshotTrace();
    const secondCapture = armColdSceneCapture(() => false, second.trace, 'm2');
    assert.deepEqual(first.outcomes(), ['not-armed:superseded'], 'a later load registered before this one\'s geometry arrived');
    secondCapture.entryWritten(null);
    assert.deepEqual(second.outcomes(), ['not-armed:no-geometry'], 'the load ended without its geometry reaching the viewport');

    const cleared = snapshotTrace();
    const scene = realScene();
    armColdSceneCapture(() => false, cleared.trace, 'm1');
    takeSceneSnapshotGeometry(arrival(), 0, rendererFor(scene), refs() as never);
    scene.queueMeshes(arrival());
    scene.clearFlatGeometry(); // a reshape after the first piece
    assert.deepEqual(cleared.outcomes(), ['not-captured:cleared']);

    noteFinalFitBounds(null as never);
    const noFit = snapshotTrace();
    armColdSceneCapture(() => false, noFit.trace, 'm1');
    await streamCold(realScene(), arrival());
    assert.deepEqual(noFit.outcomes(), ['not-captured:no-fit-bounds']);
  });
});
