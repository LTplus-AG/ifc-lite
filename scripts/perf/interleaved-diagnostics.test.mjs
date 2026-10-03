/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext, runInContext } from 'node:vm';
import { tsImport } from 'tsx/esm/api';
const { diagnosticEvent, frozenBeforeTeardown, boundedDiagnostic, writeAtomicEvidence,
  refusedRendererSnapshot, passiveRendererWitness, installReadinessMilestones } = await tsImport('./interleaved-diagnostics.ts', import.meta.url);

function snapshotRealm() {
  const context = createContext({});
  // The graph lives inside the browser-like realm: Map/Array prototypes and
  // receiver-dependent getters match the serialized callback's own globals.
  runInContext(`
    const frame = { drawCalls: 3, batchesDrawn: 2, timestamp: 41 };
    const scene = {
      batches: [{ indexCount: 6 }, { indexCount: 3 }],
      meshDataMap: new Map([[7, []], [8, []]]),
      instancedEntityMap: new Map([[9, []]]),
      getBatchedMeshes() { return this.batches; },
      hasPendingBatches() { return false; },
      isGeometryDataReleased() { return false; },
      getInstancedTemplates() { return [{ instanceCount: 1 }]; },
      hasQueuedMeshes() { return false; },
      hasStreamingFragments() { return false; },
      isFinalizeInProgress() { return false; },
      getInstancedEntityCount() { return this.instancedEntityMap.size; }
    };
    const renderer = {
      scene, ready: true, frame,
      getScene() { return this.scene; },
      isReady() { return this.ready; },
      getFrameStats() { return this.frame; }
    };
    const state = {
      loading: false, geometryStreamingActive: false, error: null,
      activeModelId: 'm', pendingInstancedShards: null,
      loadingProgress: { percent: 100 }, geometryResult: { meshes: [{}, {}, {}] },
      models: new Map([['m', { id: 'm', loadError: null, ifcDataStore: {}, loadState: 'complete', geometryLoadState: 'complete',
        metadataLoadState: 'complete', interactiveReady: true, geometryResult: { meshes: [{}, {}, {}] } }]])
    };
    function useViewerStore() { throw new Error('diagnostics must not invoke the React store hook'); }
    useViewerStore.state = state;
    useViewerStore.getState = function getState() { return this.state; };
    globalThis.__ifc_lite_viewer_store__ = useViewerStore;
    const canvas = { width: 1280, height: 900, clientWidth: 1280, clientHeight: 900,
      __reactFiber$fixture: { tag: 0, return: null,
        memoizedState: { next: null, memoizedState: { current: renderer } } } };
    globalThis.document = { visibilityState: 'visible', querySelector(selector) {
      if (selector !== 'canvas') throw new Error('unexpected selector');
      return canvas;
    } };
    globalThis.performance = { now() { return 42; } };
    function chain(count, link) {
      let head = null;
      for (let i = 0; i < count; i++) head = { tag: 0, [link]: head };
      return head;
    }
  `, context, { timeout: 1000 });
  return { context, capture: () => JSON.parse(JSON.stringify(runInContext(
    `(${refusedRendererSnapshot.toString()})()`, context, { timeout: 1000 }))) };
}

test('#6537 actual transpiled diagnostic callback survives closure-free browser serialization', () => {
  const realm = snapshotRealm();
  assert.equal(runInContext('typeof __name', realm.context), 'undefined');
  assert.equal(runInContext('typeof process', realm.context), 'undefined');
  const observed = realm.capture();
  assert.equal(observed.rendererFound, true);
  assert.equal(observed.rendererReady, true);
  assert.deepEqual(observed.frame, { drawCalls: 3, batchesDrawn: 2, timestamp: 41 });
  assert.equal(observed.load.modelCount, 1);
  assert.equal(observed.load.geometryMeshes, 3);
  assert.equal(observed.load.loading, false);
  assert.equal(observed.load.streaming, false);
  assert.equal(observed.model.metadataLoadState, 'complete');
  assert.deepEqual(observed.scene, { pendingBatches: false, geometryReleased: false, queued: false, fragments: false, finalizing: false,
    batchCount: 2, flatOwners: 2, instanceOwners: 1, instancedCount: 1, gpuInstanceOccurrences: 1 });
  runInContext('renderer.ready = false; renderer.frame = null; state.loading = true;', realm.context);
  const changed = realm.capture();
  assert.equal(changed.rendererReady, false);
  assert.equal(changed.frame, null);
  assert.equal(changed.load.loading, true);
});
test('#6537 serialized passive witness reads a function-shaped Zustand API without invoking the hook', () => {
  const realm = snapshotRealm();
  const capture = () => JSON.parse(JSON.stringify(runInContext(
    `(${passiveRendererWitness.toString()})()`, realm.context, { timeout: 1000 })));
  const before = capture();
  assert.equal(before.loading, false);
  assert.equal(before.streaming, false);
  assert.equal(before.rendererDebugHookPresent, false);
  runInContext(`
    state.loading = true; state.geometryStreamingActive = true;
    globalThis.__ifc_lite_render_stats__ = function renderStats() {
      throw new Error('passive witness must not invoke the renderer stats hook');
    };
  `, realm.context);
  const after = capture();
  assert.equal(after.loading, true);
  assert.equal(after.streaming, true);
  assert.equal(after.rendererDebugHookPresent, true);
});
test('#6537 serialized callback reports exhausted traversal bounds in its isolated realm', () => {
  const realm = snapshotRealm();
  runInContext('canvas.__reactFiber$fixture = chain(201, "return");', realm.context);
  assert.equal(realm.capture().traversal.fiberCapExhausted, true);
  runInContext('canvas.__reactFiber$fixture = { tag: 0, return: null, memoizedState: chain(2049, "next") };', realm.context);
  const exhausted = realm.capture();
  assert.equal(exhausted.traversal.hookCapExhausted, true);
  assert.equal(exhausted.traversal.complete, false);
  assert.equal(exhausted.rendererFound, false);
});

test('#6537 diagnostic events preserve observer delivery time and loading versus teardown attribution', () => {
  const loading = diagnosticEvent('console', 'Device lost', 'load-and-readiness', 1000, 1250);
  const teardown = diagnosticEvent('pageerror', 'Device destroyed', 'teardown', 1000, 1800);
  assert.equal(Date.parse(loading.capturedUTC), 1250);
  assert.equal(loading.elapsedMs, 250);
  assert.equal(teardown.elapsedMs - loading.elapsedMs, 550);
  assert.notEqual(loading.phase, teardown.phase);
});
test('#6537 partial evidence-write failure preserves the prior refusal and removes only its own temporary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'viewer-diagnostic-'));
  try {
    const path = join(directory, 'receipt.json');
    const original = JSON.stringify({ status: 'refused', reason: 'readiness timeout' });
    writeFileSync(path, original);
    assert.throws(() => writeAtomicEvidence(path, '{"status":"complete"}', fd => {
      writeSync(fd, 'partial'); throw new Error('injected disk-full after actual partial write');
    }), /disk-full/);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.deepEqual(readdirSync(directory), ['receipt.json']);
    writeAtomicEvidence(path, JSON.stringify({ status: 'refused', teardown: 'complete' }));
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).teardown, 'complete');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('#6537 diagnostic graph traversal distinguishes exact 200-node completion from exhausted limits', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const chain = (count, link) => {
    let head = null;
    for (let index = 0; index < count; index++) head = { tag: 0, [link]: head };
    return head;
  };
  const canvas = { width: 1, height: 1, clientWidth: 1, clientHeight: 1, __reactFiber$fixture: null };
  // This fixture supplies the canvas graph; assertions exercise the actual bounded walk.
  Object.defineProperty(globalThis, 'document', { configurable: true,
    value: { visibilityState: 'visible', querySelector: () => canvas } });
  try {
    canvas.__reactFiber$fixture = chain(200, 'return');
    assert.deepEqual(refusedRendererSnapshot().traversal,
      { fiberCapExhausted: false, hookCapExhausted: false, visitedFibers: 200, complete: true, totalHooks: 0, hookWalks: Array.from({ length: 200 }, () => ({ tag: 0, hooks: 0 })) });
    canvas.__reactFiber$fixture = chain(201, 'return');
    assert.equal(refusedRendererSnapshot().traversal.fiberCapExhausted, true);
    canvas.__reactFiber$fixture = { tag: 0, return: null, memoizedState: chain(2048, 'next') };
    assert.equal(refusedRendererSnapshot().traversal.hookCapExhausted, false);
    canvas.__reactFiber$fixture.memoizedState = chain(2049, 'next');
    const exhausted = refusedRendererSnapshot();
    assert.equal(exhausted.traversal.hookCapExhausted, true);
    assert.equal(exhausted.traversal.complete, false);
    assert.equal(exhausted.rendererFound, false);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'document', prior);
    else delete globalThis.document;
  }
});
test('#6537 frozen refusal witness cannot absorb later teardown events or diagnostic mutation', () => {
  const row = { status: 'refused', reason: 'readiness timeout' };
  const events = [diagnosticEvent('console', 'stream complete', 'load-and-readiness', 0, 1)];
  const observed = { frame: null, queued: true };
  const snapshot = frozenBeforeTeardown(row, events, observed, 2);
  events.push(diagnosticEvent('console', 'Device lost', 'teardown', 0, 3));
  observed.queued = false;
  const saved = JSON.parse(snapshot.captured);
  assert.equal(saved.events.length, 1);
  assert.equal(saved.observed.queued, true);
  assert.equal(saved.status, 'refused');
  assert.equal(saved.reason, 'readiness timeout');
  assert.equal(snapshot.sha256, createHash('sha256').update(snapshot.captured).digest('hex'));
});
test('#6537 diagnostic rejection and hung observations terminate as unavailable', async () => {
  const failed = await boundedDiagnostic(Promise.reject(new Error('page closed')), 100);
  assert.equal(failed.status, 'unavailable'); assert.match(failed.reason, /page closed/);
  const hung = await boundedDiagnostic(new Promise(() => {}), 5);
  assert.equal(hung.status, 'unavailable'); assert.match(hung.reason, /deadline/);
});

test('#6537 passive producer milestones preserve console delegation and survive actual serialization', () => {
  const realm = createContext({});
  runInContext(`
    let now = 10; const delegated = []; const listeners = [];
    class HTMLInputElement { constructor() { this.files = [{}]; } }
    const input = new HTMLInputElement();
    globalThis.performance = { now() { return now; } };
    globalThis.document = { querySelector() { return input; }, addEventListener(type, fn, capture) {
      if (type !== 'change' || capture !== true) throw new Error('wrong upload event boundary');
      listeners.push(fn);
    } };
    globalThis.console = { log(...args) { delegated.push({ receiver: this === console, args }); } };
  `, realm);
  runInContext(`(${installReadinessMilestones.toString()})()`, realm);
  runInContext(`listeners[0]({ target: input }); now = 20;
    console.log('[useIfc] Geometry streaming complete: 1 batch', { unchanged: true });
    now = 50; console.log('[useIfc] Data model parsing complete for x.ifc');`, realm);
  const record = JSON.parse(runInContext('JSON.stringify(__ifc_lite_comparison_milestones__)', realm));
  assert.equal(record.uploadMs, 10); assert.equal(record.geometryMs, 20); assert.equal(record.metadataMs, 50);
  assert.equal(record.error, null);
  assert.equal(runInContext('delegated[0].receiver', realm), true);
  assert.equal(runInContext('delegated[0].args[1].unchanged', realm), true);
  runInContext('listeners[0]({ target: input });', realm);
  assert.match(runInContext('__ifc_lite_comparison_milestones__.error', realm), /first single-file/);
  assert.throws(() => runInContext(`(${installReadinessMilestones.toString()})()`, realm), /already installed/);
});
test('#6537 Hook discovery ignores non-component memoizedState and rejects real Hook cycles', () => {
  const realm = snapshotRealm();
  runInContext(`const root = { tag: 3, memoizedState: { next: null }, return: null };
    root.memoizedState.next = root.memoizedState; canvas.__reactFiber$fixture.return = root;`, realm.context);
  assert.equal(realm.capture().traversal.complete, true);
  runInContext('canvas.__reactFiber$fixture.memoizedState.next = canvas.__reactFiber$fixture.memoizedState;', realm.context);
  assert.throws(() => realm.capture(), /hook cycle/);
});
