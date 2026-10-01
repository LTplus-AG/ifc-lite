/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcCreator } from '@ifc-lite/create';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import type { MeshData } from '@ifc-lite/geometry';
import { applyRemeshConfig, remeshOnApi, styleWireOnApi } from '../../../../packages/geometry/src/remesh/remesh-core.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId.js';
import { createBlankIfcFile } from '@/utils/createBlankIfc.js';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service.js';
import { useIfcLoader } from '@/hooks/useIfcLoader.js';

const wasmPath = fileURLToPath(new URL('../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const wasmAvailable = existsSync(wasmPath);
export const skip = wasmAvailable ? false : 'Run pnpm build to supply the real WASM engine (#6232).';
export let hook: ReturnType<typeof useIfcLoader> | null = null;
export let secondHook: ReturnType<typeof useIfcLoader> | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const originalFetch = globalThis.fetch;
export let remeshCalls = 0;

function Probe() { hook = useIfcLoader(); return null; }
function SecondProbe() { secondHook = useIfcLoader(); return null; }

/** Actual blank action fixture; the mm variant uses the same canonical creator. */
export function blankFile(unit: 'METRE' | 'MILLIMETRE'): File {
  if (unit === 'METRE') return createBlankIfcFile();
  const creator = new IfcCreator({ Name: 'Blank millimetres', LengthUnit: unit });
  creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
  return new File([creator.toIfc().content], 'blank-mm.ifc', { type: 'application/ifc' });
}

/** Actual worker core; an optional triangle partition exercises renderer part
 * identity without substituting a parser, coordinate frame or engine result. */
export function installRealRemesh(transform: (meshes: MeshData[]) => MeshData[] = meshes => meshes): void {
  setRemeshClientFactory(async config => {
    const api = new IfcAPI();
    let alive = true;
    applyRemeshConfig(api, config);
    return {
      get alive() { return alive; },
      remesh: async request => {
        remeshCalls++;
        const result = remeshOnApi(api, request);
        return { ...result, meshes: transform(result.meshes) };
      },
      styleWire: async buffer => styleWireOnApi(api, buffer),
      setConfig: next => applyRemeshConfig(api, next),
      dispose() { alive = false; api.free(); },
    };
  });
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
  installRealRemesh();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<><Probe /><SecondProbe /></>));
  assert.ok(hook);
});

afterEach(async () => {
  useViewerStore.getState().exitModelWorkspace();
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

export async function load(file: File, modelId?: string): Promise<FederatedModel> {
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

export function wallMeshes(modelId: string, expressId: number): MeshData[] {
  const state = useViewerStore.getState();
  const globalId = toGlobalIdFromModels(state.models, modelId, expressId);
  return state.models.get(modelId)?.geometryResult?.meshes.filter(mesh => mesh.expressId === globalId) ?? [];
}

/** World IFC Z-up corners, independently measured from the actual engine mesh. */
export function bounds(meshes: MeshData[]) {
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
