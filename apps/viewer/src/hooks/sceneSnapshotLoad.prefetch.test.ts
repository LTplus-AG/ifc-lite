/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pre-pixel lane (load hillclimb, 2026-11-12): a snapshot reopen read and
// decoded the stored scene only after the renderer was up, although neither
// needs a device. On Holter, BWK and advanced_model that put the IndexedDB
// read and the decode (30-60 ms) behind the renderer start-up. The read now
// starts with the adoption and the scene is drawn the moment the renderer is
// ready. Driven through the real renderer Scene on a stub GPU device.
import '@/test/setup-dom.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRef } from 'react';
import { encodeSceneSnapshot, type Renderer, type RenderPipeline, type SceneSnapshot } from '@ifc-lite/renderer';
import { NOOP_LOAD_TRACE } from '@ifc-lite/load-trace';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from '../../../../packages/renderer/src/scene.js';
import { useViewerStore } from '../store/index.js';
import { sceneSnapshotKey } from '../components/viewer/sceneSnapshotOwnership.js';
import { clearGlobalRefs, setGlobalRendererRef } from './useBCF.js';
import { adoptCachedSceneSnapshot } from './sceneSnapshotLoad.js';
import type { CacheResult } from '../services/cacheService.js';

(globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8, COPY_SRC: 4, STORAGE: 128 };

const BOUNDS = { min: { x: 0, y: 0, z: 0 }, max: { x: 9, y: 2, z: 1 } };
const device = {
  limits: { maxBufferSize: 1 << 28 },
  createBuffer: ({ usage }: { usage: number }) => ({ usage, destroy() {} }),
  createBindGroup: () => ({}),
  queue: { writeBuffer: () => {} },
} as unknown as GPUDevice;
const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;

function triangle(expressId: number, x: number): MeshData {
  return { expressId, modelIndex: 0, color: [1, 0, 0, 1], positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) } as MeshData;
}

function quantizedScene(): Scene {
  const scene = new Scene();
  scene.setQuantizedBatches(true);
  return scene;
}

/** A finished two-triangle scene, as a cold load's finalize captures it. */
async function finishedScene(): Promise<SceneSnapshot> {
  const scene = quantizedScene();
  let captured: SceneSnapshot | null = null;
  scene.captureNextFinalize((snapshot) => { captured = snapshot; });
  scene.queueMeshes([triangle(1, 0), triangle(2, 2)]);
  scene.flushPending(device, pipeline, 1000);
  await scene.finalizeStreamingAsync(device, pipeline);
  assert.ok(captured, 'the finalize captured the scene');
  return { ...(captured as SceneSnapshot), hostData: { fitBounds: BOUNDS, sceneBounds: BOUNDS, orbitAnchorBounds: null, shards: null } };
}

/** The renderer surface adoption touches, around a real Scene. */
function rendererFor(scene: Scene): Renderer {
  const camera = { reset() {}, fitBoundsAdaptive() {}, setSceneBounds() {}, setOrbitAnchorBounds() {} };
  return { getGPUDevice: () => device, getPipeline: () => pipeline, getScene: () => scene, getCamera: () => camera,
    getCanvas: () => null, clearCaches() {}, requestRender() {}, enableQuantizedBatches: async () => true } as unknown as Renderer;
}

const savedGpu = Object.getOwnPropertyDescriptor(globalThis.navigator, 'gpu');
beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'gpu', { configurable: true, value: {} });
  useViewerStore.setState({ appliedEntityLevelOffsets: new Map() });
});
afterEach(() => {
  clearGlobalRefs();
  if (savedGpu) Object.defineProperty(globalThis.navigator, 'gpu', savedGpu);
  else delete (globalThis.navigator as { gpu?: unknown }).gpu;
});

describe('snapshot reopen: the stored scene is read while the renderer starts', () => {
  it('reads the snapshot before any renderer exists, and adopts it once one does', async () => {
    const scene = quantizedScene();
    const bytes = await new Response(encodeSceneSnapshot(await finishedScene())).arrayBuffer();
    const { typeViewMode, typeVisibility } = useViewerStore.getState();
    const ref = createRef<Renderer | null>() as { current: Renderer | null };
    setGlobalRendererRef(ref); // the viewport has mounted; its renderer is still starting
    const events: string[] = [];
    const sceneSnapshot = { size: bytes.byteLength, arrayBuffer: async () => { events.push(ref.current ? 'read:renderer-up' : 'read:no-renderer'); return bytes; } };
    const cacheResult = { buffer: new Blob([new Uint8Array(64)]), sceneSnapshot, sceneSnapshotKey: sceneSnapshotKey(scene.sceneSnapshotPolicy(), typeViewMode, typeVisibility) } as unknown as CacheResult;

    const adopting = adoptCachedSceneSnapshot(cacheResult, 'm', () => false, NOOP_LOAD_TRACE);
    await new Promise((resolve) => setTimeout(resolve, 60)); // a few renderer polls with no renderer
    events.push('renderer-up');
    ref.current = rendererFor(scene);
    const adopted = await adopting;

    assert.deepEqual(events, ['read:no-renderer', 'renderer-up'], 'the snapshot was read only after the renderer came up');
    assert.ok(adopted, 'the snapshot was adopted');
    assert.equal(scene.getBatchedMeshes().length > 0, true, 'the adopted batches are in the scene');
  });

  it('a read that fails while the renderer starts still drops the hit as corrupt', async () => {
    const scene = quantizedScene();
    const { typeViewMode, typeVisibility } = useViewerStore.getState();
    const ref = { current: null as Renderer | null };
    setGlobalRendererRef(ref);
    const sceneSnapshot = { size: 8, arrayBuffer: async () => { throw new Error('NotReadableError'); } };
    const cacheResult = { buffer: new Blob([new Uint8Array(64)]), sceneSnapshot, sceneSnapshotKey: sceneSnapshotKey(scene.sceneSnapshotPolicy(), typeViewMode, typeVisibility) } as unknown as CacheResult;
    const adopting = adoptCachedSceneSnapshot(cacheResult, 'm', () => false, NOOP_LOAD_TRACE);
    await new Promise((resolve) => setTimeout(resolve, 40));
    ref.current = rendererFor(scene);
    await assert.rejects(adopting, /NotReadableError/);
    assert.equal(scene.getBatchedMeshes().length, 0);
  });
});
