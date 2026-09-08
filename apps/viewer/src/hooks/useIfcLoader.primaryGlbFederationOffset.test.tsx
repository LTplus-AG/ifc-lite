/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pins that a PRIMARY `.glb` load registers itself in the federation registry
 * (`registerModelOffset`), exactly like every other primary format does.
 *
 * `finalizeModel`'s primary branch (`useIfcLoader.ts`) used to guard the
 * registration on `if (dataStore && geometryResult)`; it now guards on
 * `if (geometryResult)` alone. For a primary GLB, `loadFile`'s GLB branch
 * deliberately passes `dataStore: null` into `finalizeModel` ("Primary keeps
 * the historical null data store (GLB has no entities)") — so the old guard
 * never fired for a primary GLB, and the registry's `nextOffset` never
 * advanced past 0. A federated model added afterwards was then assigned an
 * offset that started at (or below) the primary GLB's own max expressId, so
 * the two models' mesh ids overlapped: primary mesh `k` and federated mesh
 * `k` (local id) collided in the shared id space
 * `FederationRegistry.toGlobalId`/`fromGlobalId` resolve through.
 *
 * `useIfcLoader.federatedIdOffset.test.tsx` documented this exact gap in its
 * own header ("GLB is the one primary format that does NOT register") and
 * works around it by seeding the registry directly rather than driving a real
 * primary load; its header is corrected alongside this file, since the gap it
 * described is the one fixed here. This file drives BOTH loads for real —
 * a primary GLB via `loadFile(file, { kind: 'primary' })`, then a federated
 * GLB via `loadFile(file, { kind: 'federated', modelId })` — and asserts the
 * federated model's `idOffset` does not overlap the primary's mesh ids.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore, type FederatedModel } from '@/store';
import { useIfcLoader } from './useIfcLoader.js';

// ─── A real, minimal GLB fixture (mirrors useIfcLoader.federatedIdOffset.test.tsx) ──

function buildGLB(expressId: number): Uint8Array {
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
    nodes: [{ mesh: 0, extras: { expressId } }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1 },
            indices: 2,
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.7, 0.7, 0.7, 1.0],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        extensions: { KHR_materials_unlit: {} },
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      {
        bufferView: 1,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
      },
      {
        bufferView: 2,
        componentType: 5125,
        count: 3,
        type: 'SCALAR',
      },
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
  // pad bytes default to 0

  return out;
}

function glbFile(name: string, expressId: number): File {
  return new File([buildGLB(expressId) as BlobPart], name, { type: 'model/gltf-binary' });
}

// ─── Harness: the real hook, rendered ──────────────────────────────────────

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
  useViewerStore.getState().clearAllModels(); // also clears the federation registry
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

describe('useIfcLoader — a primary .glb must register in the federation registry', () => {
  it('a federated add after a primary GLB gets a disjoint idOffset (no mesh-id overlap)', async () => {
    // Primary GLB, one mesh at expressId 500.
    const primaryExpressId = 500;
    const primaryFile = glbFile('primary.glb', primaryExpressId);
    await act(async () => {
      await hookApi!.loadFile(primaryFile, { kind: 'primary' });
    });

    const { models } = useViewerStore.getState();
    assert.equal(models.size, 1, 'the primary load must have created exactly one model');
    const primaryModel = Array.from(models.values())[0]!;
    assert.equal(primaryModel.geometryResult?.meshes.length, 1, 'the primary fixture carries exactly one mesh');
    assert.equal(primaryModel.geometryResult!.meshes[0]!.expressId, primaryExpressId, 'sanity: primary mesh keeps its raw expressId (idOffset 0 on a lone primary)');

    // Federated GLB, one mesh at LOCAL expressId 10 (well inside the
    // primary's [0, 500] range if the registry never advanced).
    const federatedLocalExpressId = 10;
    const federatedFile = glbFile('federated.glb', federatedLocalExpressId);
    await act(async () => {
      await hookApi!.loadFile(federatedFile, { kind: 'federated', modelId: 'federated-model' });
    });

    const federatedModel = useViewerStore.getState().models.get('federated-model') as FederatedModel | undefined;
    assert.ok(federatedModel, 'the federated load must have registered a model');
    assert.ok(federatedModel.geometryResult, 'the federated model must carry a geometryResult');

    const federatedGlobalMeshId = federatedModel.geometryResult!.meshes[0]!.expressId;

    // The bug: if the primary GLB never registered with the federation
    // registry, `idOffset` for the federated add stays 0 (or otherwise fails
    // to clear the primary's own max expressId), so the federated mesh's
    // GLOBAL id collides with the primary's mesh id space [0, primaryExpressId].
    assert.ok(
      federatedModel.idOffset > primaryExpressId,
      `the federated model's idOffset (${federatedModel.idOffset}) must be greater than the primary GLB's max expressId (${primaryExpressId}) — `
      + 'otherwise the federated model\'s ids fall inside the primary\'s own id range',
    );
    assert.ok(
      federatedGlobalMeshId > primaryExpressId,
      `the federated mesh's global expressId (${federatedGlobalMeshId}) must not fall inside the primary GLB's id range [0, ${primaryExpressId}] — `
      + 'a global id inside that range is indistinguishable from one of the primary model\'s own meshes',
    );
  });
});
