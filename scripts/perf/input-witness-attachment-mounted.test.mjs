/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tsImport } from 'tsx/esm/api';
import { discoverViewerInput } from './input-witness-discovery.mjs';
import { installViewerInputWitness } from './input-witness-install.mjs';
import { canonicalEmptyBytes } from './input-witness-empty-fixture.mjs';
import { boundedGpuBytes, triangleCompatibilityBytes, GPU_USAGE } from './input-witness-canonical-fixtures.mjs';

// Real mounted ingestion hook, canonical store, decoder, Camera and Scene.
// The byte-allocation/bind-group GPU facade does not execute a GPU or renderer
// frame. Explicit synthetic triangle compatibility bytes are NOT model output.
const sourceDir = process.env.BASE_DIR ?? fileURLToPath(new URL('../../', import.meta.url));
if (process.env.BASE_DIR && execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' }).trim()
  !== '7dfc29870b0aa6a593c163592fcb84a92e5dfa19') throw new Error('REFUSE: mounted fixture subject mismatch');
const options = { parentURL: import.meta.url, tsconfig: join(sourceDir, 'apps/viewer/tsconfig.json') };
await tsImport(join(sourceDir, 'apps/viewer/src/test/setup-dom.ts'), options);
const requireViewer = createRequire(join(sourceDir, 'apps/viewer/package.json'));
const { createElement, useRef, useState, useEffect, useSyncExternalStore, act } = requireViewer('react');
const { createRoot } = requireViewer('react-dom/client');
const { createStore } = requireViewer('zustand/vanilla');
const [{ Scene }, { Camera }, { createDataSlice }, { useGeometryStreaming }, debug] = await Promise.all([
  tsImport(join(sourceDir, 'packages/renderer/src/scene.ts'), options),
  tsImport(join(sourceDir, 'packages/renderer/src/camera.ts'), options),
  tsImport(join(sourceDir, 'apps/viewer/src/store/slices/dataSlice.ts'), options),
  tsImport(join(sourceDir, 'apps/viewer/src/components/viewer/useGeometryStreaming.ts'), options),
  tsImport(join(sourceDir, 'apps/viewer/src/lib/viewport-debug-hooks.ts'), options),
]);

test('#6537 mounted canonical pending drain observes geometry and IFNS parsed before renderer init', async () => {
  assert.equal(document.querySelector('canvas'), null, 'fresh welcome state has no canvas');
  const previous = new Map(Object.getOwnPropertyNames(globalThis)
    .filter(name => name.startsWith('__ifc_lite_') || name === 'GPUBufferUsage')
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const scene = new Scene(), camera = new Camera(), gpu = boundedGpuBytes();
  // Binding objects are opaque GPU-only adapters; CPU batching remains real.
  gpu.device.createBindGroup = descriptor => ({ descriptor });
  const pipeline = { getUniformBufferSize() { return 256; }, getBindGroupLayout() { return {}; } };
  let ready = false, completeInit, requests = 0;
  const init = new Promise(resolve => { completeInit = resolve; });
  const renderer = { isReady() { return ready; }, getScene() { return scene; }, getGPUDevice() { return gpu.device; },
    getCamera() { return camera; }, getCanvas() { return container.querySelector('canvas'); }, getPipeline() { return pipeline; }, requestRender() { requests++; }, clearCaches() {} };
  const api = createStore((set, get, storeApi) => ({ ...createDataSlice(set, get, storeApi), models: new Map(),
    loading: false, geometryStreamingActive: false, appliedEntityLevelOffsets: new Map() }));
  const store = Object.assign(function () { throw new Error('Store hook must not be invoked'); }, api);
  Object.defineProperty(globalThis, '__ifc_lite_viewer_store__', { configurable: true, writable: true, value: store });
  Object.defineProperty(globalThis, 'GPUBufferUsage', { configurable: true, writable: true, value: GPU_USAGE });
  const geometry = [{ expressId: 10, modelIndex: 0, ifcType: 'IfcWall', geometryClass: 0, color: [1, 0, 0, 1],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }];
  const metadata = { entities: { count: 3 }, properties: { count: 0 }, entityIndex: { byType: new Map() } };
  const originalAdd = scene.addInstancedShard;
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  function Mounted({ geometry, modelIdToIndex }) {
    const rendererRef = useRef(renderer), geometryBoundsRef = useRef({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } });
    const [isInitialized, setInitialized] = useState(false);
    const state = useSyncExternalStore(api.subscribe, api.getState);
    useEffect(() => {
      let cancelled = false;
      init.then(() => {
        if (cancelled) return;
        ready = true;
        // The actual production setter seam precedes the initialized commit.
        debug.installViewportDebugHooks(renderer, () => ({ hiddenIds: new Set(), isolatedIds: null }), () => 0);
        setInitialized(true);
      });
      return () => { cancelled = true; debug.clearViewportDebugHooks(); };
    }, []);
    useGeometryStreaming({ rendererRef, isInitialized, geometry, modelIdToIndex,
      modelIdToOffset: new Map([['primary', 0]]), presentInstancedModelIndices: new Set([0]),
      isStreaming: false, geometryBoundsRef, pendingInstancedShards: state.pendingInstancedShards,
      pendingMeshColorUpdates: null, pendingColorUpdates: null, pendingMeshRemovals: null,
      pendingMeshTranslations: null, pendingMeshRotations: null,
      clearPendingMeshColorUpdates() {}, clearPendingColorUpdates() {}, clearPendingMeshRemovals() {},
      clearPendingMeshTranslations() {}, clearPendingMeshRotations() {}, pruneGeometryMeshes() {},
      clearInstancedShards: state.clearInstancedShards, clearColorRef: { current: [1, 1, 1, 1] } });
    return createElement('canvas', { 'data-viewport': 'main' });
  }
  try {
    const registration = installViewerInputWitness({ discoverySource: discoverViewerInput.toString(),
      bounds: { deliveries: 100, calls: 100, retainedBytes: 1024 ** 2 },
      referenceAudit: { subjectHead: 'c'.repeat(40), manifestSha256: 'a'.repeat(64), immutableArguments: true } });
    assert.equal(registration.awaitsRendererReady, true);
    const bytes = triangleCompatibilityBytes();
    api.setState({ activeModelId: 'primary', models: new Map([['primary', { visible: true, idOffset: 0, ifcDataStore: metadata }]]) });
    api.getState().appendInstancedShards('primary', [canonicalEmptyBytes(), bytes, canonicalEmptyBytes()]);
    await act(async () => { root.render(createElement(Mounted, { geometry, modelIdToIndex: new Map([['primary', 0]]) })); });
    assert.equal(scene.meshDataMap.size, 0); assert.equal(scene.getInstancedEntityCount(), 0);
    assert.equal(api.getState().pendingInstancedShards.length, 3, 'real initialization gate retains undrained input');
    await act(async () => { completeInit(); await init; });
    assert.equal(scene.meshDataMap.get(10).length, 1, 'actual flat ingestion retains the produced triangle');
    assert.deepEqual(Array.from(scene.meshDataMap.get(10)[0].positions), Array.from(geometry[0].positions));
    assert.equal(scene.getInstancedEntityCount(), 2, 'actual decoder and Scene retain both opaque occurrences');
    assert.equal(api.getState().pendingInstancedShards, null, 'canonical effect drains and clears original pending input');
    const witness = globalThis.__ifc_lite_input_witness__, frozen = witness.freeze();
    assert.strictEqual(frozen.deliveries[1].buffer, bytes);
    assert.strictEqual(frozen.inputs[1].shard.templates[0].positions.buffer, bytes);
    assert.strictEqual(scene.instancedTemplateCpu[0].positions, frozen.inputs[1].shard.templates[0].positions);
    assert.equal(frozen.inputs[1].accepted, true);
    assert.equal(frozen.calls, 3);
    assert.equal(frozen.inputs.filter(item => item.empty && item.accepted).length, 2);
    assert.deepEqual(frozen.deliveries.map(item => item.ingestions), [1, 1, 1]); assert.ok(requests > 0);
    const nativeHook = globalThis.__ifc_lite_render_stats__;
    assert.equal(witness.dispose().restored, true);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, '__ifc_lite_render_stats__');
    assert.strictEqual(descriptor.value, nativeHook);
    assert.equal(descriptor.configurable, true); assert.equal(descriptor.enumerable, true); assert.equal(descriptor.writable, true);
    assert.strictEqual(scene.addInstancedShard, originalAdd);
  } finally {
    globalThis.__ifc_lite_input_witness__?.dispose();
    await act(async () => { root.unmount(); }); container.remove(); scene.clear();
    for (const name of Object.getOwnPropertyNames(globalThis).filter(name => name.startsWith('__ifc_lite_') || name === 'GPUBufferUsage')) {
      if (!previous.has(name)) delete globalThis[name];
    }
    for (const [name, descriptor] of previous) Object.defineProperty(globalThis, name, descriptor);
    assert.equal(gpu.liveCount, 0, 'canonical cleanup destroys all adapted GPU allocations');
  }
});
