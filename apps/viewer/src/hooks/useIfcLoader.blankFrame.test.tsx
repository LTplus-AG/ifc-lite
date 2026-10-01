/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcCreator } from '@ifc-lite/create';
import { IfcParser } from '@ifc-lite/parser';
import { WorkerParser } from '@ifc-lite/parser/browser';
import { serializeEntitySubgraph } from '@ifc-lite/export';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import { applyRemeshConfig, remeshOnApi, styleWireOnApi } from '../../../../packages/geometry/src/remesh/remesh-core.js';
import { resolveRtcFrame } from '../../../../packages/geometry/src/rtc-frame.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId.js';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records.js';
import { createBlankIfcFile } from '@/utils/createBlankIfc.js';
import { requestRemesh, setRemeshClientFactory } from '@/lib/remesh/remesh-service.js';
import { useIfcLoader } from './useIfcLoader.js';
import { advance, waitFor } from '@/test/render.js';
import { launchModelCommand } from '@/lib/commands/modeling/keys-workspace.js';

const wasmPath = fileURLToPath(new URL('../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const wasmAvailable = existsSync(wasmPath);
const skip = wasmAvailable ? false : 'Run pnpm build to supply the real WASM engine (#6232).';
let hook: ReturnType<typeof useIfcLoader> | null = null;
let secondHook: ReturnType<typeof useIfcLoader> | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const originalFetch = globalThis.fetch;
let remeshCalls = 0;

function Probe() { hook = useIfcLoader(); return null; }
function SecondProbe() { secondHook = useIfcLoader(); return null; }

/** Actual blank action fixture; the mm variant uses the same canonical creator. */
function blankFile(unit: 'METRE' | 'MILLIMETRE'): File {
  if (unit === 'METRE') return createBlankIfcFile();
  const creator = new IfcCreator({ Name: 'Blank millimetres', LengthUnit: unit });
  creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
  return new File([creator.toIfc().content], 'blank-mm.ifc', { type: 'application/ifc' });
}

beforeEach(async () => {
  if (!wasmAvailable) return;
  remeshCalls = 0;
  // Serve the actual binary for Node's file-URL fetch boundary. No engine,
  // parser, event, frame or mesh result is replaced by a canned response.
  globalThis.fetch = async (input, options) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('file:') && url.endsWith('ifc-lite_bg.wasm')) {
      return new Response(readFileSync(wasmPath), { headers: { 'Content-Type': 'application/wasm' } });
    }
    return originalFetch(input, options);
  };
  initSync({ module: readFileSync(wasmPath) });
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  // The existing remesh factory substitutes only transport. It executes the
  // exact real worker core and releases its own API deterministically.
  setRemeshClientFactory(async config => {
    const api = new IfcAPI();
    let alive = true;
    applyRemeshConfig(api, config);
    return {
      get alive() { return alive; },
      remesh: async request => { remeshCalls++; return remeshOnApi(api, request); },
      styleWire: async buffer => styleWireOnApi(api, buffer),
      setConfig: next => applyRemeshConfig(api, next),
      dispose() { alive = false; api.free(); },
    };
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<><Probe /><SecondProbe /></>));
  assert.ok(hook);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  hook = null;
  secondHook = null;
  container?.remove();
  container = null;
  setRemeshClientFactory(null);
  await Promise.resolve();
  globalThis.fetch = originalFetch;
  mock.restoreAll();
});

async function load(file: File, modelId?: string): Promise<FederatedModel> {
  assert.ok(hook);
  await act(async () => hook?.loadFile(file, modelId ? { kind: 'federated', modelId } : { kind: 'primary' }));
  const state = useViewerStore.getState();
  const model = state.models.get(modelId ?? state.activeModelId ?? '');
  assert.ok(model);
  if (!modelId) assert.equal(model.loadState, 'complete', model.loadError ?? 'load must complete');
  else assert.equal(model.loadPath, 'wasm', 'federated model is published only after actual WASM completion');
  assert.ok(model.ifcDataStore);
  useViewerStore.getState().setEditEnabled(true);
  return model;
}

function wallMeshes(modelId: string, expressId: number): MeshData[] {
  const state = useViewerStore.getState();
  const globalId = toGlobalIdFromModels(state.models, modelId, expressId);
  return state.models.get(modelId)?.geometryResult?.meshes.filter(mesh => mesh.expressId === globalId) ?? [];
}

/** World IFC Z-up corners, independently measured from the actual engine mesh. */
function bounds(meshes: MeshData[]) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    const o = mesh.origin ?? [0, 0, 0];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const p = [o[0] + mesh.positions[i], -(o[2] + mesh.positions[i + 2]), o[1] + mesh.positions[i + 1]];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], p[axis]); max[axis] = Math.max(max[axis], p[axis]);
      }
    }
  }
  return { min, max };
}

/** Hold delivery of one genuinely decoded store, not a parser's result. */
function holdFirstMetadata(count = 1) {
  const parse = IfcParser.prototype.parseColumnar;
  const entries = Array.from({ length: count }, () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    return { release, gate, decoded: false };
  });
  let calls = 0;
  mock.method(IfcParser.prototype, 'parseColumnar', async function (
    this: IfcParser, ...args: Parameters<typeof parse>
  ) {
    const entry = entries[calls++];
    const store = await parse.apply(this, args);
    if (entry) {
      entry.decoded = true;
      await entry.gate;
    }
    return store;
  });
  return {
    release: (index = 0) => entries[index].release(),
    decoded: (index = 0) => entries[index].decoded,
  };
}

describe('owned primary completion and launcher (#6232)', () => {
  it('cancels a real WorkerParser request before any metadata callback and releases its producer', { skip }, async () => {
    assert.ok(hook);
    // Replace only Worker allocation: the real WorkerParser owns its pending
    // request, signal, handler teardown and promise settlement. This transport
    // deliberately delivers no metadata, as with a terminated browser worker.
    class SilentParserWorker {
      terminated = false;
      onmessage: Worker['onmessage'] = null;
      onerror: Worker['onerror'] = null;
      onmessageerror: Worker['onmessageerror'] = null;
      postMessage() {}
      terminate() { this.terminated = true; }
    }
    const transport: { worker?: SilentParserWorker; parser?: WorkerParser } = {};
    let disposed = 0;
    let fallbackParses = 0;
    const dispose = GeometryProcessor.prototype.dispose;
    mock.method(GeometryProcessor.prototype, 'dispose', function (this: GeometryProcessor) {
      disposed++;
      return dispose.call(this);
    });
    const mainThreadParse = IfcParser.prototype.parseColumnar;
    mock.method(IfcParser.prototype, 'parseColumnar', function (
      this: IfcParser, ...args: Parameters<typeof mainThreadParse>
    ) { fallbackParses++; return mainThreadParse.apply(this, args); });
    const parse = WorkerParser.prototype.parseColumnar;
    mock.method(WorkerParser, 'isSupported', () => true);
    mock.method(WorkerParser.prototype, 'parseColumnar', function (
      this: WorkerParser, ...args: Parameters<typeof parse>
    ) {
      transport.parser = this;
      const previous = globalThis.Worker;
      // No geometry worker or result is substituted. Restore the global
      // immediately after this synchronous parser-transport allocation.
      globalThis.Worker = class extends SilentParserWorker {
        constructor() { super(); transport.worker = this; }
      } as unknown as typeof Worker;
      try { return parse.apply(this, args); }
      finally { globalThis.Worker = previous; }
    });
    let settled = false;
    const pending = hook.loadFile(blankFile('METRE')).then(() => { settled = true; });
    try {
      await waitFor(() => !!transport.worker && !!useViewerStore.getState().geometryResult
        && !useViewerStore.getState().geometryStreamingActive, 'real engine finishes while parser worker has emitted nothing');
      assert.ok(transport.worker);
      assert.equal(transport.worker.terminated, false);
      const cancel = useViewerStore.getState().activeLoadCanceller;
      assert.ok(cancel, 'worker metadata completion must retain the owned Cancel control');
      await act(async () => cancel());
      await waitFor(() => settled && transport.worker?.terminated === true, 'cancel settles the caller and terminates the real pending WorkerParser');
      assert.equal(useViewerStore.getState().models.size, 0);
      assert.equal(useViewerStore.getState().ifcDataStore, null);
      assert.equal(useViewerStore.getState().loading, false);
      assert.equal(useViewerStore.getState().error, null, 'owned worker cancellation is not a failed parse');
      await waitFor(() => disposed > 0, 'cancelled parser and geometry release their shared producer');
      assert.equal(disposed, 1, 'the real producer is disposed exactly once');
      assert.equal(fallbackParses, 0, 'a cancelled parser cannot start an obsolete fallback decode');
    } finally {
      transport.parser?.terminate();
      await act(async () => pending);
      await advance(20);
    }
  });

  it('failed metadata delivery settles completion, frees the real producer and marks the primary incomplete', { skip }, async () => {
    assert.ok(hook);
    const parse = IfcParser.prototype.parseColumnar;
    const failure = new Error('metadata delivery failed after real decode (#6232)');
    mock.method(IfcParser.prototype, 'parseColumnar', async function (
      this: IfcParser, ...args: Parameters<typeof parse>
    ) { await parse.apply(this, args); throw failure; });
    let disposed = 0;
    const dispose = GeometryProcessor.prototype.dispose;
    mock.method(GeometryProcessor.prototype, 'dispose', function (this: GeometryProcessor) {
      disposed++;
      return dispose.call(this);
    });
    await act(async () => hook?.loadFile(blankFile('METRE')));
    await waitFor(() => disposed > 0, 'a failed metadata transport settles the shared producer ownership');
    assert.equal(disposed, 1);
    const state = useViewerStore.getState();
    assert.equal(state.models.size, 1, 'retain the canonical primary error record');
    const primary = state.models.get(state.activeModelId ?? '');
    assert.equal(primary?.loadState, 'error', 'failed metadata cannot become a completed model');
    assert.ok(primary?.loadError?.includes('metadata delivery failed'));
    assert.equal(state.loading, false);
    assert.equal(state.activeLoadCanceller, null);
    assert.equal(useViewerStore.getState().session, null);
  });

  it('resolves only after real metadata registers the exact requested primary, then launches Wall', { skip }, async () => {
    assert.ok(hook);
    const held = holdFirstMetadata();
    const target = { kind: 'primary' as const, modelId: 'blank-launch-owner' };
    let settled = false;
    const pending = hook.loadFile(blankFile('METRE'), target).then(() => { settled = true; });
    try {
      await waitFor(() => held.decoded() && !!useViewerStore.getState().geometryResult
        && !useViewerStore.getState().geometryStreamingActive, 'real geometry finishes while decoded metadata is held');
      await advance(100);
      assert.equal(settled, false, 'loadFile must not release its launcher before metadata/model registration');
      assert.ok(useViewerStore.getState().activeLoadCanceller, 'metadata completion remains cancellable');
      held.release();
      await act(async () => pending);
      const state = useViewerStore.getState();
      assert.equal(state.activeModelId, target.modelId);
      assert.equal(state.models.get(target.modelId)?.loadState, 'complete');
      assert.equal(launchModelCommand('wall.place'), true, 'the actual workspace command accepts this completed blank model');
      assert.equal(useViewerStore.getState().session?.activeCommandId, 'wall.place');
    } finally { held.release(); await act(async () => pending); }
  });

  it('cancel after geometry settles without waiting for a missing metadata callback', { skip }, async () => {
    assert.ok(hook);
    const held = holdFirstMetadata();
    let settled = false;
    const pending = hook.loadFile(blankFile('METRE')).then(() => { settled = true; });
    try {
      await waitFor(() => held.decoded() && !!useViewerStore.getState().geometryResult
        && !useViewerStore.getState().geometryStreamingActive, 'real geometry completes before held metadata');
      const cancel = useViewerStore.getState().activeLoadCanceller;
      assert.ok(cancel, 'the active load owns cancellation until metadata settles');
      await act(async () => cancel());
      await waitFor(() => settled, 'owned cancellation settles loadFile without onFullDataStore');
      const state = useViewerStore.getState();
      assert.equal(state.models.size, 0);
      assert.equal(state.ifcDataStore, null);
      assert.equal(state.loading, false);
      assert.equal(state.activeLoadCanceller, null);
      assert.equal(state.session, null, 'a cancelled blank cannot launch a modeling session');
      held.release();
      await advance(20);
      assert.equal(useViewerStore.getState().models.size, 0, 'a later decoded callback cannot republish the cancelled model');
    } finally { held.release(); await act(async () => pending); }
  });

  for (const oldKind of ['primary', 'federated'] as const) {
    it(`a new primary in another hook abandons an older ${oldKind} finalizer without late publication`, { skip }, async () => {
      assert.ok(hook && secondHook);
      if (oldKind === 'federated') await load(blankFile('METRE'));
      const held = holdFirstMetadata();
      let oldSettled = false;
      const oldTarget = oldKind === 'primary'
        ? { kind: 'primary' as const, modelId: 'obsolete-primary' }
        : { kind: 'federated' as const, modelId: 'obsolete-peer' };
      const oldLoad = hook.loadFile(blankFile('METRE'), oldTarget).then(() => { oldSettled = true; });
      try {
        await waitFor(held.decoded, 'old real parser has decoded its store before supersession');
        await act(async () => secondHook?.loadFile(blankFile('MILLIMETRE')));
        const current = useViewerStore.getState();
        const currentId = current.activeModelId;
        const currentStore = current.ifcDataStore;
        assert.ok(currentId && currentStore);
        const currentModel = current.models.get(currentId);
        assert.equal(currentModel?.loadState, 'complete');
        await waitFor(() => oldSettled, 'new primary abandons the other hook finalizer without old metadata');
        held.release();
        await advance(100);
        const after = useViewerStore.getState();
        assert.equal(after.activeModelId, currentId);
        assert.equal(after.ifcDataStore, currentStore, 'obsolete metadata cannot overwrite the new primary');
        assert.equal(after.models.size, 1, 'obsolete federated metadata cannot append a ghost model');
        assert.equal(after.models.get(currentId), currentModel);
        assert.equal(after.loading, false);
        assert.equal(after.error, null);
      } finally { held.release(); await act(async () => oldLoad); }
    });
  }

  it('obsolete federated completion cannot clear the newer primary loading UI or its cancellation owner', { skip }, async () => {
    assert.ok(hook && secondHook);
    await load(blankFile('METRE'));
    const held = holdFirstMetadata(2);
    const oldLoad = hook.loadFile(blankFile('METRE'), { kind: 'federated', modelId: 'obsolete-ui-owner' });
    let newLoad: Promise<void> | undefined;
    try {
      await waitFor(() => held.decoded(0), 'real old peer metadata is decoded');
      newLoad = secondHook.loadFile(blankFile('MILLIMETRE'));
      await waitFor(() => held.decoded(1) && !!useViewerStore.getState().geometryResult
        && !useViewerStore.getState().geometryStreamingActive, 'new primary geometry finishes with its own metadata still held');
      const currentCancel = useViewerStore.getState().activeLoadCanceller;
      assert.ok(currentCancel);
      assert.equal(useViewerStore.getState().loading, true, 'new metadata completion still owns the loading UI');
      held.release(0);
      await act(async () => oldLoad);
      const state = useViewerStore.getState();
      assert.equal(state.loading, true, 'obsolete post-finalize flags cannot dismiss the new load');
      assert.equal(state.activeLoadCanceller, currentCancel);
      assert.equal(state.models.size, 1, 'only the new primary placeholder owns the replacement session');
      assert.equal(state.models.has('obsolete-ui-owner'), false, 'old peer cannot publish into the replacement session');
      held.release(1);
      await act(async () => newLoad);
      assert.equal(useViewerStore.getState().models.size, 1);
    } finally { held.release(0); held.release(1); await act(async () => { await oldLoad; await newLoad; }); }
  });

  it('concurrent federated hooks retain both genuine decoded models until independently completed', { skip }, async () => {
    assert.ok(hook && secondHook);
    const primary = await load(blankFile('METRE'));
    const held = holdFirstMetadata();
    const first = hook.loadFile(blankFile('METRE'), { kind: 'federated', modelId: 'first-peer' });
    try {
      await waitFor(held.decoded, 'first peer metadata is actually decoded');
      await act(async () => secondHook?.loadFile(blankFile('MILLIMETRE'), { kind: 'federated', modelId: 'second-peer' }));
      assert.equal(useViewerStore.getState().models.get(primary.id), primary);
      assert.ok(useViewerStore.getState().models.get('second-peer'));
      held.release();
      await act(async () => first);
      const models = useViewerStore.getState().models;
      assert.equal(models.size, 3);
      assert.equal(models.get(primary.id), primary);
      assert.equal(models.get('first-peer')?.geometryResult?.coordinateInfo?.lengthUnitScale, 1);
      assert.equal(models.get('second-peer')?.geometryResult?.coordinateInfo?.lengthUnitScale, 0.001);
      assert.equal(useViewerStore.getState().activeLoadCanceller, null);
    } finally { held.release(); await act(async () => first); }
  });
});

describe('canonical blank file → author → real WASM remesh (#6232)', () => {
  for (const unit of ['METRE', 'MILLIMETRE'] as const) {
    it(`${unit}: zero-job streaming emits actual engine metadata before completion`, { skip }, async () => {
      // A blank hierarchy still supplies two spatial-product jobs that yield
      // no meshes. For the distinct zero-job engine invariant, export the
      // real project's forward closure (context and units, no products).
      const store = await new IfcParser().parseColumnar(await blankFile(unit).arrayBuffer(), { disableWorkerScan: true });
      const project = store.entityIndex.byType.get('IFCPROJECT')?.[0];
      assert.ok(project);
      const bytes = serializeEntitySubgraph(store, null, { targets: new Set([project]) }).bytes;
      const events: Array<Record<string, unknown>> = [];
      const api = new IfcAPI();
      try {
        api.buildPrePassStreaming(bytes, (event: Record<string, unknown>) => events.push(event), 25, null, false);
        const metaIndex = events.findIndex(event => event.type === 'meta');
        const completeIndex = events.findIndex(event => event.type === 'complete');
        assert.ok(metaIndex >= 0 && completeIndex > metaIndex, 'real zero-job prepass still reports producer metadata');
        assert.equal(events[completeIndex].totalJobs, 0);
        assert.equal(events[metaIndex].unitScale, unit === 'METRE' ? 1 : 0.001);
      } finally { api.clearPrePassCache(); api.free(); }
    });

    for (const count of [1, 2]) {
      it(`${unit}, ${count} models: blank primary can create a physical wall and Undo/Redo once`, { skip }, async () => {
        const file = blankFile(unit), api = new IfcAPI();
        let expectedFrame;
        try {
          const pre = api.buildPrePassOnce(new Uint8Array(await file.arrayBuffer()));
          expectedFrame = resolveRtcFrame(pre);
        } finally { api.clearPrePassCache(); api.free(); }
        const primary = await load(file);
        let peer: FederatedModel | undefined;
        if (count === 2) {
          peer = await load(blankFile(unit), 'peer');
          assert.ok(peer.idOffset > primary.maxExpressId, 'blank primary spatial ids reserve their federation range');
        }
        const state = useViewerStore.getState();
        const storey = primary.ifcDataStore?.entityIndex.byType.get('IFCBUILDINGSTOREY')?.[0];
        assert.ok(storey);
        assert.ok(modelEditTarget(state, primary.id), 'the canonical modelling command opens its mutation view');
        const wall = state.addWall(primary.id, storey, { Start: [2, 3, 0], End: [6, 3, 0], Thickness: 0.2, Height: 3 });
        assert.ok('expressId' in wall, 'error' in wall ? wall.error : 'wall creation must succeed');
        const outcome = await requestRemesh(useViewerStore.getState, primary.id, [wall.expressId], 'created');
        assert.equal(outcome.status, 'applied', 'blank canonical load must preserve the engine frame for authoring');
        const loaded = useViewerStore.getState().models.get(primary.id);
        assert.ok(loaded?.geometryResult?.coordinateInfo?.wasmRtcFrame);
        assert.deepEqual(loaded.geometryResult.coordinateInfo.wasmRtcFrame, expectedFrame, 'retain the exact engine-selected frame');
        assert.equal(loaded.geometryResult.coordinateInfo.lengthUnitScale, unit === 'METRE' ? 1 : 0.001);
        assert.ok(loaded.maxExpressId > 0);
        const meshes = wallMeshes(primary.id, wall.expressId);
        assert.ok(meshes.length > 0 && meshes.some(mesh => mesh.indices.length > 0));
        const measured = bounds(meshes);
        for (const [actual, expected] of [[measured.min, [2, 2.9, 0]], [measured.max, [6, 3.1, 3]]] as const) {
          actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-5, `${value} vs ${expected[i]}`));
        }
        assert.equal(useViewerStore.getState().undoStacks.get(primary.id)?.length, 1);
        useViewerStore.getState().undo(primary.id);
        assert.equal(wallMeshes(primary.id, wall.expressId).length, 0);
        assert.equal(useViewerStore.getState().undoStacks.get(primary.id)?.length, 0);
        useViewerStore.getState().redo(primary.id);
        assert.equal((await requestRemesh(useViewerStore.getState, primary.id, [wall.expressId], 'created')).status, 'applied');
        assert.deepEqual(bounds(wallMeshes(primary.id, wall.expressId)), measured);
        assert.equal(useViewerStore.getState().undoStacks.get(primary.id)?.length, 1);
        if (peer) assert.equal(useViewerStore.getState().models.get(peer.id), peer, 'editing the primary never replaces its blank peer');
      });
    }
  }

  it('missing producer provenance still refuses remesh rather than assuming identity', { skip }, async () => {
    const model = await load(blankFile('METRE'));
    if (model.geometryResult?.coordinateInfo) {
      const unknownFrame = { ...model.geometryResult.coordinateInfo };
      delete unknownFrame.wasmRtcFrame;
      useViewerStore.getState().setGeometryResult({ ...model.geometryResult, coordinateInfo: unknownFrame });
    }
    const storey = model.ifcDataStore?.entityIndex.byType.get('IFCBUILDINGSTOREY')?.[0];
    assert.ok(storey);
    assert.ok(modelEditTarget(useViewerStore.getState(), model.id));
    const wall = useViewerStore.getState().addWall(model.id, storey, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    assert.deepEqual(await requestRemesh(useViewerStore.getState, model.id, [wall.expressId], 'created'), { status: 'refused', reason: 'noFrame' });
    assert.equal(remeshCalls, 0, 'unknown producer provenance never reaches the real engine remesh');
  });
});
