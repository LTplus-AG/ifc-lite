/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A federated GLB/IFCX/point-cloud add threw a TDZ `ReferenceError` on
 * `allInstancedShards` (found while writing PR #2768, which pins the
 * federated id-offset write side but deliberately did not fix this).
 *
 * `finalizeModel` (the one finalizer shared by every format/target, added by
 * the loadFile unification) reads `allInstancedShards` at its federated
 * branch to forward GPU-instancing shard bytes (#1912). That variable is
 * declared with `const` ~800 lines further down `loadFile`, inside the
 * WASM-streaming section — a section GLB, IFCX, and point-cloud loads never
 * reach. `finalizeModel` is called for those formats BEFORE that `const`
 * executes, so the read lands in the binding's temporal dead zone and
 * throws — after `addModel` already registered the model with its real,
 * correctly-loaded geometry. The catch around the format branch then
 * marks the (already-live) model `loadState: 'error'`, so a user federating
 * a GLB sees a failed model that in fact loaded.
 *
 * This drives the real `useIfcLoader` hook (not a source-text scan) with a
 * hand-built, minimal-but-valid GLB — the workable fixture per this repo's
 * WASM-in-test constraint (`happy-dom` defines `window`, which defeats the
 * Node `fs`-fallback in `IfcLiteBridge.init()`, so the WASM engine cannot
 * init under this harness). GLB/IFCX/point-cloud parse WITHOUT the WASM
 * engine, which is exactly why they are reachable here and exactly why they
 * are the formats the bug report names.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { useIfcLoader } from './useIfcLoader.js';

/**
 * Minimal valid GLB (binary glTF), one triangle, one unlit material.
 * Adapted from `packages/cache/src/glb.test.ts`'s `buildGLB` (same shape
 * `GLTFExporter` produces) — kept single-triangle since this test only
 * needs `detectFormat` to route to the GLB branch and `loadGLBToMeshData`
 * to hand back at least one mesh.
 */
function buildMinimalGLB(): Uint8Array<ArrayBuffer> {
  const verts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const norms = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const idx = new Uint32Array([0, 1, 2]);

  const posBytes = new Uint8Array(verts.buffer);
  const normBytes = new Uint8Array(norms.buffer);
  const idxBytes = new Uint8Array(idx.buffer);

  const json = {
    asset: { version: '2.0', generator: 'test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, extras: { expressId: 100 } }],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 },
        ],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: { baseColorFactor: [0.8, 0.2, 0.2, 1.0], metallicFactor: 0, roughnessFactor: 1 },
        extensions: { KHR_materials_unlit: {} },
      },
    ],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, byteOffset: 0, componentType: 5125, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.byteLength, byteStride: 12, target: 34962 },
      { buffer: 0, byteOffset: posBytes.byteLength, byteLength: normBytes.byteLength, byteStride: 12, target: 34962 },
      { buffer: 0, byteOffset: posBytes.byteLength + normBytes.byteLength, byteLength: idxBytes.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: posBytes.byteLength + normBytes.byteLength + idxBytes.byteLength }],
  };

  const jsonStr = JSON.stringify(json);
  const jsonBuf = new TextEncoder().encode(jsonStr);
  const jsonPad = (4 - (jsonBuf.byteLength % 4)) % 4;
  const jsonChunkLen = jsonBuf.byteLength + jsonPad;

  const binLen = posBytes.byteLength + normBytes.byteLength + idxBytes.byteLength;
  const binPad = (4 - (binLen % 4)) % 4;
  const binChunkLen = binLen + binPad;

  const total = 12 + 8 + jsonChunkLen + 8 + binChunkLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonChunkLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(jsonBuf, 20);
  for (let i = 0; i < jsonPad; i++) out[20 + jsonBuf.byteLength + i] = 0x20;

  let off = 20 + jsonChunkLen;
  dv.setUint32(off, binChunkLen, true);
  dv.setUint32(off + 4, 0x004e4942, true); // BIN
  off += 8;
  out.set(posBytes, off);
  off += posBytes.byteLength;
  out.set(normBytes, off);
  off += normBytes.byteLength;
  out.set(idxBytes, off);

  return out;
}

// ─── Harness: the real hook, rendered ────────────────────────────────────

let hookApi: ReturnType<typeof useIfcLoader> | null = null;

function Probe(): null {
  hookApi = useIfcLoader();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  hookApi = null;
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(hookApi, 'the hook must expose loadFile');
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  if (container) container.remove();
  container = null;
});

describe('useIfcLoader — federated GLB add must not hit the allInstancedShards TDZ', () => {
  it('finishes with the model live (not loadState "error") and its meshes present', async () => {
    // A primary model must already be resident: `finalizeModel`'s federated
    // branch (the one that reads the TDZ'd variable) only runs for
    // `target.kind === 'federated'`, and a federated add is only meaningful
    // once model #1 exists.
    const primaryBytes = buildMinimalGLB();
    const primaryFile = new File([primaryBytes], 'primary.glb');
    await act(async () => {
      await hookApi!.loadFile(primaryFile);
    });
    const afterPrimary = useViewerStore.getState();
    assert.equal(afterPrimary.models.size, 1, 'primary GLB load must register exactly one model');
    const primaryId = [...afterPrimary.models.keys()][0];
    assert.notEqual(
      afterPrimary.models.get(primaryId)?.loadState,
      'error',
      'the primary GLB load itself must not error',
    );

    const federatedBytes = buildMinimalGLB();
    const federatedFile = new File([federatedBytes], 'federated.glb');
    const modelId = crypto.randomUUID();

    let caught: unknown = null;
    await act(async () => {
      try {
        await hookApi!.loadFile(federatedFile, { kind: 'federated', modelId, name: 'federated.glb' });
      } catch (err) {
        caught = err;
      }
    });

    // `loadFile` catches its own errors internally (it never rethrows to the
    // caller) — the TDZ `ReferenceError` is swallowed by the format branch's
    // own try/catch and surfaces as a store-level error state instead. This
    // assertion exists so a future refactor that DOES let it escape fails
    // loudly here with the real error, rather than only via the loadState
    // assertion below.
    assert.equal(caught, null, `loadFile must not throw; got: ${String(caught)}`);

    const after = useViewerStore.getState();
    const federated = after.models.get(modelId);
    assert.ok(federated, 'the federated model must be registered in the store (addModel ran before the crash)');
    assert.notEqual(
      federated!.loadState,
      'error',
      'a federated GLB add that parsed and registered successfully must not be left in loadState "error" '
      + '(the allInstancedShards TDZ ReferenceError fires AFTER addModel succeeds, in useIfcLoader.ts)',
    );
    assert.ok(
      federated!.geometryResult && federated!.geometryResult.meshes.length > 0,
      'the federated model must carry its parsed meshes',
    );
    assert.equal(after.models.size, 2, 'both the primary and federated models must be present');
  });
});
