/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcCreator } from '@ifc-lite/create';
import { IfcParser } from '@ifc-lite/parser';
import { serializeEntitySubgraph } from '@ifc-lite/export';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import type { MeshData } from '@ifc-lite/geometry';
import { applyRemeshConfig, remeshOnApi, styleWireOnApi } from '../../../../packages/geometry/src/remesh/remesh-core.js';
import { resolveRtcFrame } from '../../../../packages/geometry/src/rtc-frame.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId.js';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records.js';
import { createBlankIfcFile } from '@/utils/createBlankIfc.js';
import { requestRemesh, setRemeshClientFactory } from '@/lib/remesh/remesh-service.js';
import { useIfcLoader } from './useIfcLoader.js';

const wasmPath = fileURLToPath(new URL('../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const wasmAvailable = existsSync(wasmPath);
const skip = wasmAvailable ? false : 'Run pnpm build to supply the real WASM engine (#6232).';
let hook: ReturnType<typeof useIfcLoader> | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const originalFetch = globalThis.fetch;

function Probe() { hook = useIfcLoader(); return null; }

/** Actual blank action fixture; the mm variant uses the same canonical creator. */
function blankFile(unit: 'METRE' | 'MILLIMETRE'): File {
  if (unit === 'METRE') return createBlankIfcFile();
  const creator = new IfcCreator({ Name: 'Blank millimetres', LengthUnit: unit });
  creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
  return new File([creator.toIfc().content], 'blank-mm.ifc', { type: 'application/ifc' });
}

beforeEach(async () => {
  if (!wasmAvailable) return;
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
    applyRemeshConfig(api, config);
    return {
      alive: true,
      remesh: async request => remeshOnApi(api, request),
      styleWire: async buffer => styleWireOnApi(api, buffer),
      setConfig: next => applyRemeshConfig(api, next),
      dispose() { this.alive = false; api.free(); },
    };
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<Probe />));
  assert.ok(hook);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  hook = null;
  container?.remove();
  container = null;
  setRemeshClientFactory(null);
  await Promise.resolve();
  globalThis.fetch = originalFetch;
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

describe('canonical blank file → author → real WASM remesh (#6232)', () => {
  for (const unit of ['METRE', 'MILLIMETRE'] as const) {
    it(`${unit}: zero-job streaming emits actual engine metadata before completion`, { skip }, async () => {
      // A blank hierarchy still supplies two spatial-product jobs that yield
      // no meshes. For the distinct zero-job engine invariant, export the
      // real project's forward closure (context and units, no products).
      const store = await new IfcParser().parseColumnar(await blankFile(unit).arrayBuffer(), { disableWorkerScan: true });
      const project = store.entityIndex.byType.get('IFCPROJECT')?.[0];
      assert.ok(project);
      const bytes = serializeEntitySubgraph(store, null, { targets: [project] }).bytes;
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
    const existingParts = wallMeshes(model.id, wall.expressId);
    assert.deepEqual(await requestRemesh(useViewerStore.getState, model.id, [wall.expressId], 'created'), { status: 'refused', reason: 'noFrame' });
    assert.deepEqual(wallMeshes(model.id, wall.expressId), existingParts, 'refusal preserves the existing authored fallback');
  });
});
