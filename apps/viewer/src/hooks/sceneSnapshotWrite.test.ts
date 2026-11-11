/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// W2 (load hillclimb, reopen lane): a primary cold load stores its finished
// scene beside its cache entry after the load, so the FIRST reopen adopts it.
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLoadTracer, type LoadTrace } from '@ifc-lite/load-trace';
import { decodeSceneSnapshot, type Renderer, type SceneSnapshot } from '@ifc-lite/renderer';
import { useViewerStore } from '../store/index.js';
import { clearCache, getCached, setCached } from '../services/ifc-cache.js';
import { noteFinalFitBounds } from '../components/viewer/sceneSnapshotOwnership.js';
import { setGlobalRendererRef } from './useBCF.js';
import { armColdSceneCapture } from './sceneSnapshotLoad.js';
import { writeCapturedScene, type CapturedScene, type SnapshotEntry } from './sceneSnapshotWrite.js';

const BOUNDS = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 2, z: 3 } };

function snapshot(): SceneSnapshot {
  return {
    policy: 'p', pieceCount: 1, nextSplitId: 1, sharedFrameOrigins: [], activeBuckets: [],
    batches: [{ key: 'k', color: [1, 0, 0, 1], vertexBytes: 28, expressIds: new Uint32Array([7]), ordinals: new Uint32Array([0]),
      vertexData: new Uint8Array(28).fill(3), indices: new Uint32Array([0, 0, 0]) }],
  };
}

const captured = (): CapturedScene => ({ snapshot: snapshot(), key: 'policy|types', fit: { fitBounds: BOUNDS, sceneBounds: BOUNDS, orbitAnchorBounds: null } as unknown as CapturedScene['fit'] });

/** A real recording trace, and a promise for the outcome the writer ends its span with. */
function tracedSpan(): { trace: LoadTrace; span: number; outcome: () => string | undefined } {
  const tracer = createLoadTracer({ enabled: true, sink: null });
  const trace = tracer.startLoad('w2');
  const span = trace.begin('cache.writeSceneSnapshot');
  return { trace, span, outcome: () => tracer.latest()?.spans.find((s) => s.name === 'cache.writeSceneSnapshot' && s.end !== null)?.attrs?.outcome as string | undefined };
}

async function entryOf(key: string): Promise<SnapshotEntry> {
  const write = await setCached(key, new ArrayBuffer(64), `${key}.ifc`, 64, undefined, { fullSourceHash: 'h' });
  assert.ok(write, 'the entry write committed');
  return { cacheKey: key, write, shards: { offset: 16, size: 8 } };
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * The snapshot Blob each put hands IndexedDB. fake-indexeddb returns a structured
 * clone of happy-dom's Blob, which has no `arrayBuffer`, so the bytes are read here.
 */
const putSnapshots = new Map<string, Blob>();
const storeProto = (globalThis as unknown as { IDBObjectStore: { prototype: { put: (value: unknown, key?: unknown) => unknown } } }).IDBObjectStore.prototype;
const originalPut = storeProto.put;
storeProto.put = function put(this: unknown, value: unknown, key?: unknown) {
  const entry = value as { key?: string; sceneSnapshot?: Blob };
  if (entry?.key && entry.sceneSnapshot) putSnapshots.set(entry.key, entry.sceneSnapshot);
  return originalPut.call(this, value, key);
};
const storedSnapshot = async (key: string) => {
  const blob = putSnapshots.get(key);
  return blob ? decodeSceneSnapshot(await blob.arrayBuffer()) : null;
};

const originalIdle = window.requestIdleCallback;
beforeEach(async () => {
  putSnapshots.clear();
  await clearCache();
  useViewerStore.setState({ loading: true, geometryStreamingActive: false });
  window.requestIdleCallback = ((cb: IdleRequestCallback) => Number(setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0))) as typeof window.requestIdleCallback;
});
afterEach(() => {
  window.requestIdleCallback = originalIdle;
  setGlobalRendererRef({ current: null });
  useViewerStore.setState({ loading: false, geometryStreamingActive: false });
});

describe('writeCapturedScene', () => {
  it('waits for the load to be interactive, then stores the frozen scene with its entry\'s shard location', async () => {
    const entry = await entryOf('a');
    const { trace, span, outcome } = tracedSpan();
    const written = writeCapturedScene(captured(), Promise.resolve(entry), () => false, trace, span);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await getCached('a'))!.sceneSnapshot, undefined, 'nothing is written while the load is still running');
    assert.equal(outcome(), undefined, 'the pending write keeps its span open');
    useViewerStore.setState({ loading: false });
    assert.equal(await written, 'written');
    const hit = (await getCached('a'))!;
    assert.equal(hit.sceneSnapshotKey, 'policy|types');
    assert.ok(hit.sceneSnapshot, 'the entry carries the snapshot');
    const decoded = await storedSnapshot('a');
    assert.deepEqual(decoded?.hostData, { fitBounds: BOUNDS, sceneBounds: BOUNDS, orbitAnchorBounds: null, shards: { offset: 16, size: 8 } });
    assert.deepEqual([...decoded!.batches[0].vertexData], [...snapshot().batches[0].vertexData]);
    assert.equal(outcome(), 'written');
  });

  it('drops the capture when another file opens before the load settles', async () => {
    const entry = await entryOf('b');
    let stale = false;
    const { trace, span, outcome } = tracedSpan();
    const written = writeCapturedScene(captured(), Promise.resolve(entry), () => stale, trace, span);
    stale = true;
    assert.equal(await written, 'abandoned');
    useViewerStore.setState({ loading: false });
    assert.equal((await getCached('b'))!.sceneSnapshot, undefined);
    assert.equal(outcome(), 'abandoned');
  });

  it('writes nothing when the load stored no entry', async () => {
    useViewerStore.setState({ loading: false });
    const { trace, span } = tracedSpan();
    assert.equal(await writeCapturedScene(captured(), Promise.resolve(null), () => false, trace, span), 'no-entry');
  });

  it('does not wait for an idle period in a hidden tab', async () => {
    const entry = await entryOf('c');
    useViewerStore.setState({ loading: false });
    window.requestIdleCallback = (() => 0) as typeof window.requestIdleCallback; // an idle period that never comes
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      const { trace, span } = tracedSpan();
      assert.equal(await writeCapturedScene(captured(), Promise.resolve(entry), () => false, trace, span), 'written');
    } finally {
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
      else delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });
});

/** A renderer whose scene records the capture the loader arms, and fires it on demand like a finalize swap. */
function captureRenderer(queued = false) {
  let onCaptured: ((s: SceneSnapshot) => void) | null = null;
  const scene = {
    captureNextFinalize: (cb: (s: SceneSnapshot) => void) => { onCaptured = cb; },
    sceneSnapshotPolicy: () => 'policy',
    hasQueuedMeshes: () => queued,
    getBatchedMeshes: () => [],
  };
  const camera = { getSceneBounds: () => BOUNDS, getOrbitAnchorBounds: () => null };
  const renderer = { getGPUDevice: () => ({}), getPipeline: () => ({}), getScene: () => scene, getCamera: () => camera } as unknown as Renderer;
  return { renderer, swap: () => onCaptured?.(snapshot()), armed: () => onCaptured !== null };
}

describe('armColdSceneCapture (W2)', () => {
  it('a primary cold load leaves a snapshot on its own entry once it settles, so the first reopen can adopt it', async () => {
    noteFinalFitBounds(BOUNDS as never);
    const { renderer, swap, armed } = captureRenderer();
    setGlobalRendererRef({ current: renderer });
    const tracer = createLoadTracer({ enabled: true, sink: null });
    const capture = armColdSceneCapture(() => false, tracer.startLoad('cold'));
    assert.ok(armed(), 'armed before the stream, without awaiting anything');
    swap();
    const pending = () => tracer.latest()?.spans.find((s) => s.name === 'cache.writeSceneSnapshot');
    assert.equal(pending()?.end, null, 'the pending write is an open cache.write* span from the swap on');
    capture.entryWritten(await entryOf('cold'));
    useViewerStore.setState({ loading: false });
    await until(async () => Boolean((await getCached('cold'))?.sceneSnapshot), 'the snapshot write');
    assert.equal(pending()?.attrs?.outcome, 'written');
    assert.equal((await storedSnapshot('cold'))?.batches.length, 1);
  });

  it('a cold load whose cache write was skipped keeps nothing', async () => {
    const { renderer, swap } = captureRenderer();
    setGlobalRendererRef({ current: renderer });
    const tracer = createLoadTracer({ enabled: true, sink: null });
    const capture = armColdSceneCapture(() => false, tracer.startLoad('cold'));
    swap();
    capture.entryWritten(null);
    useViewerStore.setState({ loading: false });
    await until(() => tracer.latest()?.spans.some((s) => s.name === 'cache.writeSceneSnapshot' && s.end !== null) ?? false, 'the span to end');
    assert.equal(tracer.latest()?.spans.find((s) => s.name === 'cache.writeSceneSnapshot')?.attrs?.outcome, 'no-entry');
  });

  it('does not arm on a renderer that appears after pieces were already queued', async () => {
    const nav = navigator as { gpu?: unknown };
    const hadGpu = 'gpu' in nav;
    nav.gpu ??= {}; // WebGPU present, renderer not yet mounted
    try {
      setGlobalRendererRef({ current: null });
      const late = captureRenderer(true);
      armColdSceneCapture(() => false, createLoadTracer({ enabled: true, sink: null }).startLoad('cold'));
      setGlobalRendererRef({ current: late.renderer });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(late.armed(), false, 'a capture armed after queued pieces could only fail at the swap');

      const fresh = captureRenderer(false);
      setGlobalRendererRef({ current: null });
      armColdSceneCapture(() => false, createLoadTracer({ enabled: true, sink: null }).startLoad('cold'));
      setGlobalRendererRef({ current: fresh.renderer });
      await until(fresh.armed, 'a renderer mounted on an empty scene to be armed');
    } finally {
      if (!hadGpu) delete nav.gpu;
    }
  });
});
