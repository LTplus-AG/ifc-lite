/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { createLoadTracer } from '@ifc-lite/load-trace';
import { Camera } from '../../../../../packages/renderer/src/camera.js';
import { useViewerStore } from '@/store';
import { publishLoadTrace } from '@/lib/perf/activeLoadTrace.js';
import { appearanceInstanceScene } from '@/test/appearance-instance-scene.js';
import { cleanup, render } from '@/test/render.js';
import { useGeometryStreaming } from './useGeometryStreaming.js';
import { buildShardBytes } from '@/test/instanced-shard-fixture.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';

interface State {
  meshes: MeshData[];
  streaming: boolean;
  epoch: number;
  renderer?: Renderer;
  replacement?: number;
  translations?: Map<number, [number, number, number]>;
  rotations?: Map<number, { angle: number; pivot: [number, number, number] }>;
  meshColors?: Map<number, [number, number, number, number]>;
  overlays?: Map<number, [number, number, number, number]>;
  removals?: Set<number>;
  shards?: Array<{ modelId: string; bytes: ArrayBuffer }>;
}
let update: Dispatch<SetStateAction<State>>;

function Viewport({ renderer }: { renderer: Renderer }) {
  const [state, setState] = useState<State>({ meshes: [], streaming: false, epoch: 0 });
  const queuedTranslations = useViewerStore((store) => store.pendingMeshTranslations);
  const models = useViewerStore.getState().models;
  const modelIndices = useRef(new Map([...models.keys()].map((id, index) => [id, index]))).current;
  const modelOffsets = useRef(new Map([...models].map(([id, model]) => [id, model.idOffset]))).current;
  const presentIndices = useRef(new Set(modelIndices.values())).current;
  update = setState;
  const clearShards = useCallback(() => setState((current) => current.shards ? { ...current, shards: undefined } : current), []);
  const clearTranslations = useCallback(() => {
    useViewerStore.getState().clearPendingMeshTranslations();
    setState((current) => ({ ...current, translations: undefined }));
  }, []);
  const clearRotations = useCallback(() => setState((current) => ({ ...current, rotations: undefined })), []);
  const clearMeshColors = useCallback(() => setState((current) => ({ ...current, meshColors: undefined })), []);
  const clearOverlays = useCallback(() => setState((current) => ({ ...current, overlays: undefined })), []);
  const clearRemovals = useCallback(() => setState((current) => ({ ...current, removals: undefined })), []);
  const prune = useCallback((ids: Set<number>) => setState((current) => ({ ...current, meshes: current.meshes.filter((mesh) => !ids.has(mesh.expressId)) })), []);
  const rendererRef = useRef<Renderer | null>(renderer);
  rendererRef.current = state.renderer ?? renderer;
  const geometryBoundsRef = useRef({ min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } });
  const clearColorRef = useRef<[number, number, number, number]>([0, 0, 0, 1]);
  useGeometryStreaming(Object.assign({
    rendererRef, geometry: state.meshes, geometryBoundsRef, clearColorRef,
    isInitialized: true, isStreaming: state.streaming, geometryReplacementVersion: state.replacement,
    pendingMeshColorUpdates: state.meshColors ?? null, pendingColorUpdates: state.overlays ?? null,
    pendingMeshRemovals: state.removals ?? null, pendingMeshTranslations: state.translations ?? queuedTranslations,
    pendingMeshRotations: state.rotations ?? null, pendingInstancedShards: state.shards ?? null,
    modelIdToIndex: modelIndices, modelIdToOffset: modelOffsets, presentInstancedModelIndices: presentIndices,
    clearPendingMeshColorUpdates: clearMeshColors,
    clearPendingColorUpdates: clearOverlays,
    clearPendingMeshRemovals: clearRemovals,
    pruneGeometryMeshes: prune,
    clearPendingMeshTranslations: clearTranslations,
    clearPendingMeshRotations: clearRotations,
    clearInstancedShards: clearShards,
  }, { gpuRecoveryEpoch: state.epoch }));
  return null;
}

function fixture(federated = false) {
  useViewerStore.getState().clearAllModels();
  const names = federated ? ['primary', 'source'] : ['source'];
  useViewerStore.setState(fixtureModels(...names.map((id) =>
    fixtureModel(id, { idOffset: useViewerStore.getState().registerModelOffset(id, 100) }))));
  const native = appearanceInstanceScene([]);
  const camera = new Camera();
  let available = true;
  const renderer = {
    getScene: () => native.scene, getGPUDevice: () => available ? native.device : null,
    getPipeline: () => available ? native.pipeline : null,
    getCamera: () => camera, getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
    clearCaches() {}, requestRender() {},
  } as unknown as Renderer;
  render(<Viewport renderer={renderer} />);
  const meshes = [10, 11].map((expressId) => ({
    expressId, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), color: [0.5, 0.5, 0.5, 1], ifcType: 'IfcWall',
  } as MeshData));
  return { ...native, meshes, renderer, available(value: boolean) { available = value; } };
}

const indices = (scene: ReturnType<typeof fixture>['scene']) =>
  scene.getBatchedMeshes().reduce((sum, batch) => sum + batch.indexCount, 0);

afterEach(() => { cleanup(); useViewerStore.getState().clearAllModels(); });

it('replays unchanged source geometry that arrived while the GPU was lost (#6993)', async () => {
  const native = fixture();
  native.available(false);
  await act(async () => { update({ meshes: native.meshes, streaming: false, epoch: 0 }); });
  assert.equal(indices(native.scene), 0, 'a lost device cannot upload');
  native.available(true);
  await act(async () => { update({ meshes: native.meshes, streaming: false, epoch: 1 }); });
  assert.equal(indices(native.scene), 6, 'recovery must upload both source triangles without another source update');
  for (const mesh of native.meshes) assert.equal(native.scene.getMeshData(mesh.expressId)?.expressId, mesh.expressId);
});

it('finalizes a stream that ended during device loss after recovery (#6993)', async () => {
  const tracer = createLoadTracer({ enabled: true, sink: null });
  publishLoadTrace('recovery', tracer.startLoad('recovery'));
  const native = fixture();
  native.available(false);
  await act(async () => { update({ meshes: native.meshes, streaming: true, epoch: 0 }); });
  await act(async () => { update({ meshes: native.meshes, streaming: false, epoch: 0 }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(tracer.latest()?.spans.filter((span) => span.name === 'scene.finalize' && span.end !== null).length, 0);
  native.available(true);
  await act(async () => { update({ meshes: native.meshes, streaming: false, epoch: 1 }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(indices(native.scene), 6);
  assert.equal(tracer.latest()?.spans.filter((span) => span.name === 'scene.finalize' && span.end !== null).length, 1,
    'one successful finalization follows the missed stream end');
});

it('does not duplicate meshes already owned by the recovered Scene (#6993)', async () => {
  const native = fixture();
  await act(async () => { update({ meshes: native.meshes, streaming: false, epoch: 0 }); });
  assert.equal(indices(native.scene), 6);
  await act(async () => { update({ meshes: native.meshes, streaming: false, epoch: 1 }); });
  assert.equal(indices(native.scene), 6);
});

for (const federated of [false, true]) {
  it(`replays a pending ${federated ? 'federated' : 'primary'} instanced shard after recovery (#6993)`, async () => {
    const native = fixture(federated);
    const meshes: MeshData[] = [];
    const shards = [{ modelId: 'source', bytes: buildShardBytes(42) }];
    const id = useViewerStore.getState().toGlobalId('source', 42);
    native.available(false);
    await act(async () => { update({ meshes, shards, streaming: false, epoch: 0 }); });
    assert.equal(native.scene.getInstancedMeshDataPieces(id), undefined);
    native.available(true);
    await act(async () => { update({ meshes, shards, streaming: false, epoch: 1 }); });
    const pieces = native.scene.getInstancedMeshDataPieces(id);
    assert.ok(pieces, 'the encoded instance must reach the real Scene');
    assert.equal(pieces.length, 1);
    assert.equal(pieces[0].indices.length, 3);
    assert.equal(pieces[0].modelIndex, federated ? 1 : 0);
    await act(async () => { update({ meshes, streaming: false, epoch: 2 }); });
    assert.equal(native.scene.getInstancedMeshDataPieces(id)?.length, 1, 'drained shards are not duplicated');
  });
}

for (const operation of ['translation', 'rotation', 'mesh-color', 'overlay', 'removal'] as const) {
  it(`retries a pending ${operation} after device recovery (#6993)`, async () => {
    const native = fixture();
    await act(async () => { update({ meshes: native.meshes, streaming: false, epoch: 0 }); });
    native.available(false);
    await act(async () => { update((current) => ({ ...current,
      translations: operation === 'translation' ? new Map([[10, [5, 0, 0]]]) : undefined,
      rotations: operation === 'rotation' ? new Map([[10, { angle: Math.PI / 2, pivot: [0, 0, 0] }]]) : undefined,
      meshColors: operation === 'mesh-color' ? new Map([[10, [1, 0, 0, 1]]]) : undefined,
      overlays: operation === 'overlay' ? new Map([[10, [0, 1, 0, 1]]]) : undefined,
      removals: operation === 'removal' ? new Set([10]) : undefined,
    })); });
    assert.equal(indices(native.scene), 6, 'the unavailable device leaves existing geometry intact');
    native.available(true);
    await act(async () => { update((current) => ({ ...current, epoch: 1 })); });
    const bounds = native.scene.getEntityBoundingBox(10);
    if (operation === 'translation') { assert.ok(bounds); assert.equal(bounds.min.x, 5); }
    if (operation === 'rotation') {
      assert.ok(bounds);
      assert.ok(bounds.max.z - bounds.min.z > 0.99 && bounds.max.x - bounds.min.x < 1e-5,
        'the triangle must rotate from the XY plane into the YZ plane');
    }
    if (operation === 'mesh-color') assert.deepEqual(native.scene.getMeshData(10)?.color, [1, 0, 0, 1]);
    if (operation === 'overlay') assert.deepEqual(native.scene.getColorOverrides()?.get(10), [0, 1, 0, 1]);
    if (operation === 'removal') {
      assert.equal(native.scene.hasMeshData(10), false);
      assert.equal(indices(native.scene), 3, 'the other triangle remains');
    }
    const positions = native.scene.getMeshData(10)?.positions.slice();
    await act(async () => { update((current) => ({ ...current, epoch: 2 })); });
    assert.deepEqual(native.scene.getMeshData(10)?.positions, positions, 'drained edits do not apply twice');
  });
}

it('retries an in-place remeshed source slot after device recovery (#6993)', async () => {
  const native = fixture();
  await act(async () => { update({ meshes: native.meshes, streaming: false, epoch: 0 }); });
  native.available(false);
  native.meshes[0] = { ...native.meshes[0], positions: new Float32Array([0, 0, 0, 3, 0, 0, 0, 3, 0]) };
  await act(async () => { useViewerStore.setState({ pendingMeshEdits: { ids: new Set([10]), since: 0, tick: 1 }, geometryUpdateTick: 1 }); });
  assert.equal(native.scene.getEntityBoundingBox(10)?.max.x, 1);
  native.available(true);
  await act(async () => { update((current) => ({ ...current, epoch: 1 })); });
  assert.equal(native.scene.getEntityBoundingBox(10)?.max.x, 3, 'the replacement triangle must reach the Scene');
  assert.equal(indices(native.scene), 6, 'replacement preserves exactly two triangles');
  await act(async () => { update((current) => ({ ...current, epoch: 2 })); });
  assert.equal(indices(native.scene), 6);
});

for (const operation of ['translation', 'rotation'] as const) {
  it(`retries a failed GPU rebuild without applying a ${operation} twice (#6993)`, async () => {
    const native = fixture();
    await act(async () => { update({ meshes: native.meshes, streaming: false, epoch: 0 }); });
    const allocate = native.device.createBuffer;
    native.device.createBuffer = () => { throw new Error('GPU device lost during placement rebuild'); };
    await act(async () => { update((current) => ({ ...current,
      translations: operation === 'translation' ? new Map([[10, [5, 0, 0]]]) : undefined,
      rotations: operation === 'rotation' ? new Map([[10, { angle: Math.PI / 2, pivot: [0, 0, 0] }]]) : undefined,
    })); });
    assert.equal(native.scene.hasPendingBatches(), true, 'the GPU stage remains pending');
    const positionsAfterCpuApply = native.scene.getMeshData(10)?.positions.slice();
    native.device.createBuffer = allocate;
    await act(async () => { update((current) => ({ ...current, epoch: 1 })); });
    assert.deepEqual(native.scene.getMeshData(10)?.positions, positionsAfterCpuApply,
      'the failed GPU stage must not replay the committed CPU delta');
    assert.equal(native.scene.hasPendingBatches(), false);
    assert.equal(indices(native.scene), 6);
  });
}

it('restarts finalization cancelled by a recovery epoch while the queue is draining (#6993)', async () => {
  const tracer = createLoadTracer({ enabled: true, sink: null });
  publishLoadTrace('recovery-drain', tracer.startLoad('recovery-drain'));
  const native = fixture();
  await act(async () => { update({ meshes: native.meshes, streaming: true, epoch: 0 }); });
  assert.equal(native.scene.hasQueuedMeshes(), true);
  await act(async () => { update((current) => ({ ...current, streaming: false })); });
  await act(async () => { update((current) => ({ ...current, epoch: 1 })); });
  native.scene.flushPending(native.device, native.pipeline);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
  assert.equal(tracer.latest()?.spans.filter((span) => span.name === 'scene.finalize' && span.end !== null).length, 1,
    'the cancelled queue-drain attempt must resume and complete');
  assert.equal(indices(native.scene), 6);
});

it('does not merge an already-applied placement delta into a later edit during failed uploads (#6993)', async () => {
  const native = fixture();
  await act(async () => { update({ meshes: native.meshes, streaming: false, epoch: 0 }); });
  const allocate = native.device.createBuffer;
  native.device.createBuffer = () => { throw new Error('GPU device lost during placement rebuild'); };
  await act(async () => { useViewerStore.getState().setPendingMeshTranslations(new Map([[10, [5, 0, 0]]])); });
  assert.equal(native.scene.getEntityBoundingBox(10)?.min.x, 5);
  await act(async () => { useViewerStore.getState().setPendingMeshTranslations(new Map([[10, [2, 0, 0]]])); });
  assert.equal(native.scene.getEntityBoundingBox(10)?.min.x, 7, 'the next edit adds only its new delta');
  native.device.createBuffer = allocate;
  await act(async () => { update((current) => ({ ...current, epoch: 1 })); });
  assert.equal(native.scene.getEntityBoundingBox(10)?.min.x, 7);
  assert.equal(native.scene.hasPendingBatches(), false);
});

for (const interruption of ['recovery', 'same-load-array', 'explicit-replacement', 'new-stream', 'clear', 'unmount'] as const) {
  it(`preserves only the same-load queued finalizer across ${interruption} (#6993)`, async () => {
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    let nextId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    globalThis.requestAnimationFrame = callback => { frames.set(++nextId, callback); return nextId; };
    globalThis.cancelAnimationFrame = id => { frames.delete(id); };
    try {
      const tracer = createLoadTracer({ enabled: true, sink: null });
      publishLoadTrace('queued-recovery', tracer.startLoad('queued-recovery'));
      const native = fixture();
      await act(async () => { update({ meshes: native.meshes, streaming: true, epoch: 0 }); });
      assert.equal(native.scene.hasQueuedMeshes(), true, 'real CPU queue owns both triangles');
      assert.equal(native.scene.prepareDeviceRecovery().ok, true, 'canonical recovery permits the unflushed queue');
      await act(async () => { update({ meshes: native.meshes, streaming: false, epoch: 0 }); });
      assert.ok(frames.size > 0, 'the production finalizer is waiting on the real queue');
      await act(async () => {
        if (interruption === 'unmount') cleanup();
        else update({ meshes: interruption === 'clear' ? [] : interruption === 'same-load-array' ? [...native.meshes] : native.meshes,
          streaming: interruption === 'new-stream', epoch: interruption === 'recovery' ? 1 : 0, replacement: interruption === 'explicit-replacement' ? 1 : undefined });
      });
      if (interruption === 'explicit-replacement') {
        assert.equal(native.scene.hasQueuedMeshes(), false, 'canonical replacement synchronously drains a rebuilt full Scene');
        assert.equal(native.scene.hasStreamingFragments(), false);
        assert.equal(indices(native.scene), 6, 'replacement uploads both source triangles without relying on the superseded finalizer');
      }
      if (interruption !== 'clear') native.scene.flushPending(native.device, native.pipeline);
      assert.equal(native.scene.hasQueuedMeshes(), false);
      for (let turn = 0; turn < 40; turn++) {
        await act(async () => {
          const callbacks = [...frames.values()]; frames.clear();
          for (const callback of callbacks) callback(performance.now());
          await new Promise(resolve => setTimeout(resolve, 2));
        });
        const finalized = tracer.latest()?.spans.some(span => span.name === 'scene.finalize' && span.end !== null);
        if (frames.size === 0 && ((interruption !== 'recovery' && interruption !== 'same-load-array') || finalized)) break;
      }
      const completed = () => tracer.latest()?.spans.filter(span => span.name === 'scene.finalize' && span.end !== null).length ?? 0;
      assert.equal(completed(), (interruption === 'recovery' || interruption === 'same-load-array') ? 1 : 0,
        'only the retained same-load intent may finalize; canceled owners cannot finish a later load');
      if (interruption === 'recovery' || interruption === 'same-load-array') {
        assert.equal(indices(native.scene), 6);
        assert.equal(native.scene.hasStreamingFragments(), false);
        await act(async () => { update({ meshes: native.meshes, streaming: false, epoch: 2 }); });
        assert.equal(completed(), 1, 'a completed intent is not replayed');
      }
    } finally {
      cleanup();
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancel;
    }
  });
}

it('retains a failed actual async finalizer until a later retry event, preserving its failed trace (#6993)', async () => {
  const tracer = createLoadTracer({ enabled: true, sink: null });
  publishLoadTrace('async-retry', tracer.startLoad('async-retry'));
  const native = fixture();
  await act(async () => { update({ meshes: native.meshes, streaming: true, epoch: 0 }); });
  native.scene.flushPending(native.device, native.pipeline);
  assert.equal(native.scene.hasStreamingFragments(), true, 'real queue upload produced fragments');
  const original = native.device.createBuffer;
  let refused = 0;
  native.device.createBuffer = () => { refused++; throw new RangeError('Controlled finalize allocation refusal'); };
  try {
    await act(async () => {
      update({ meshes: native.meshes, streaming: false, epoch: 0 });
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.ok(refused > 0, 'real finalizer attempted allocation');
    const failures = tracer.latest()?.spans.filter(span => span.name === 'scene.finalize' && span.attrs?.error === true);
    assert.equal(failures?.length, 1, 'actual failed completion remains reported');
    assert.equal(native.scene.hasStreamingFragments(), true, 'Scene rollback preserves its real fragments');
    assert.equal(native.scene.isFinalizeInProgress(), false);
    const attempts = refused;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(refused, attempts, 'no unbounded background retry loop');
    native.device.createBuffer = original;
    await act(async () => {
      update({ meshes: native.meshes, streaming: false, epoch: 1 });
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(indices(native.scene), 6);
    assert.equal(native.scene.hasStreamingFragments(), false);
    assert.equal(tracer.latest()?.spans.filter(span => span.name === 'scene.finalize' && span.attrs?.error === true).length, 1);
    assert.equal(tracer.latest()?.spans.filter(span => span.name === 'scene.finalize' && span.end !== null && span.attrs?.error !== true).length, 1,
      'a later real completion is recorded separately from the failed attempt');
  } finally { native.device.createBuffer = original; cleanup(); }
});

it('ignores an old completion acknowledgement while the next stream owns its queued finalizer (#6993)', async () => {
  const native = fixture();
  const tracer = createLoadTracer({ enabled: true, sink: null });
  publishLoadTrace('old-stream', tracer.startLoad('old-stream'));
  await act(async () => { update({ meshes: native.meshes, streaming: true, epoch: 0 }); });
  native.scene.flushPending(native.device, native.pipeline);
  const original = native.scene.finalizeStreamingAsync;
  let release: () => void = () => { throw new Error('Completion not held'); };
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true; let actualCompleted = false;
  native.scene.finalizeStreamingAsync = (...args) => {
    const actual = original.apply(native.scene, args);
    if (!first) return actual;
    first = false;
    // Original method executes exactly once with unchanged args. This holds
    // delivery AFTER its real GPU work completes, not the GPU work itself.
    return actual.then(async () => { actualCompleted = true; await held; });
  };
  try {
    await act(async () => { update({ meshes: native.meshes, streaming: false, epoch: 0 }); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(actualCompleted, true);
    assert.equal(native.scene.isFinalizeInProgress(), false);
    assert.equal(indices(native.scene), 6);
    const nextMeshes = [...native.meshes, { ...native.meshes[0], expressId: 12 }];
    publishLoadTrace('next-stream', tracer.startLoad('next-stream'));
    await act(async () => { update({ meshes: nextMeshes, streaming: true, epoch: 0 }); });
    assert.equal(native.scene.hasQueuedMeshes(), true, 'new source has a real queued triangle');
    await act(async () => { update({ meshes: nextMeshes, streaming: false, epoch: 0 }); });
    await act(async () => { release(); await held; });
    native.scene.flushPending(native.device, native.pipeline);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    assert.equal(native.scene.hasStreamingFragments(), false);
    assert.equal(indices(native.scene), 9);
    assert.equal(tracer.latest()?.spans.filter(span => span.name === 'scene.finalize' && span.end !== null).length, 1,
      "old acknowledgement cannot consume the next stream's finalization intent");
  } finally { release(); native.scene.finalizeStreamingAsync = original; cleanup(); }
});

it('retains ownership while an actual failed finalizer acknowledgement is held across recovery (#6993)', async () => {
  const native = fixture();
  const tracer = createLoadTracer({ enabled: true, sink: null });
  publishLoadTrace('held-failure', tracer.startLoad('held-failure'));
  await act(async () => { update({ meshes: native.meshes, streaming: true, epoch: 0 }); });
  native.scene.flushPending(native.device, native.pipeline);
  const finalize = native.scene.finalizeStreamingAsync;
  const allocate = native.device.createBuffer;
  let release: () => void = () => { throw new Error('Failure acknowledgement not held'); };
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0; let failed = false;
  native.scene.finalizeStreamingAsync = (...args) => {
    const actual = finalize.apply(native.scene, args);
    if (++calls !== 1) return actual;
    // The real Scene executes exactly once and rolls back its real allocation
    // refusal. Only delivery of that actual rejection to the hook is held.
    return actual.catch(async (error: unknown) => { failed = true; await held; throw error; });
  };
  native.device.createBuffer = () => { throw new RangeError('Controlled actual finalize allocation refusal'); };
  try {
    await act(async () => { update({ meshes: native.meshes, streaming: false, epoch: 0 }); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(failed, true, 'actual allocation failed and Scene rollback completed');
    assert.equal(native.scene.hasStreamingFragments(), true);
    native.device.createBuffer = allocate;
    await act(async () => { update((current) => ({ ...current, epoch: 1 })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(calls, 1, 'a recovery rerender cannot launch a second attempt before the first acknowledgement');
    await act(async () => { release(); await held; });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(calls, 2, 'the recovery already observed during the real failed attempt retries after acknowledgement');
    assert.equal(native.scene.hasStreamingFragments(), false);
    assert.equal(indices(native.scene), 6);
    assert.equal(tracer.latest()?.spans.filter(span => span.name === 'scene.finalize' && span.attrs?.error === true).length, 1);
  } finally { release(); native.scene.finalizeStreamingAsync = finalize; native.device.createBuffer = allocate; cleanup(); }
});


it('ignores an actual successful finalizer acknowledgement after the renderer owner is replaced (#6993)', async () => {
  const native = fixture();
  await act(async () => { update({ meshes: native.meshes, streaming: true, epoch: 0 }); });
  native.scene.flushPending(native.device, native.pipeline);
  const finalize = native.scene.finalizeStreamingAsync;
  const clearCaches = native.renderer.clearCaches;
  let release: () => void = () => { throw new Error('Success acknowledgement not held'); };
  const held = new Promise<void>(resolve => { release = resolve; });
  let completed = false, calls = 0, obsoleteCacheMutations = 0;
  native.scene.finalizeStreamingAsync = (...args) => {
    calls++;
    return finalize.apply(native.scene, args).then(async () => { completed = true; await held; });
  };
  native.renderer.clearCaches = () => { obsoleteCacheMutations++; };
  try {
    await act(async () => { update({ meshes: native.meshes, streaming: false, epoch: 0 }); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(completed, true, 'the real Scene already completed allocation and consolidation');
    assert.equal(native.scene.hasStreamingFragments(), false);
    assert.equal(indices(native.scene), 6);
    obsoleteCacheMutations = 0;
    // The GPU-frame facade changes identity while deliberately exposing the
    // same actual Scene: scene equality alone cannot establish host ownership.
    const replacement = { ...native.renderer } as unknown as Renderer;
    await act(async () => { update(current => ({ ...current, renderer: replacement })); });
    await act(async () => { release(); await held; });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(calls, 1);
    assert.equal(obsoleteCacheMutations, 0, 'a stale successful callback must not clear the old renderer caches');
    assert.equal(indices(native.scene), 6);
  } finally {
    release(); native.scene.finalizeStreamingAsync = finalize; native.renderer.clearCaches = clearCaches; cleanup();
  }
});
