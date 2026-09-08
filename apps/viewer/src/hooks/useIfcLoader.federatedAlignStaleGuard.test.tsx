/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stale-guard-after-await sweep: `useIfcLoader.ts`'s `finalizeModel`
 * FEDERATED branch, specifically its alignment await:
 *
 *   const status = await alignGeometryToReference(geometryResult, parsedGeoref, referenceGeoref);
 *   federationAlignmentStatus = status;
 *   ... (idOffset, addModel, buildSpatialIndexForModel, appendInstancedShards)
 *
 * `alignGeometryToReference` is real reprojection work — genuine wall-clock
 * duration — and it is the ONLY `await` anywhere in the federated branch
 * (verified: every write below it — `registerModelOffset`, `addModel`,
 * `buildSpatialIndexForModel`, `appendInstancedShards`,
 * `renderer.relabelPointCloudAsset` — is synchronous). Before this fix,
 * nothing re-checked `loadSessionRef` after that await, so a federated add
 * superseded by a newer primary load while its alignment was in flight would
 * still register itself, still offset every mesh id, still add itself to
 * `useViewerStore`'s `models` map, and still build a spatial index — all for
 * a load the user had already abandoned.
 *
 * **Concrete interleaving this drives.** A federation anchor model
 * ("ref-model", `EPSG:9999902`) is already in the store. Load A is a
 * federated GLB add ("model-a", `EPSG:9999901` — a different CRS from the
 * anchor, so `finalizeModel` takes the cross-CRS reprojection path, the one
 * with a real `await`). While A's alignment is in flight, the user starts an
 * entirely new PRIMARY load, load B (a plain GLB, no georef, completes
 * synchronously — no engine needed, see
 * `useIfcLoader.federatedIdOffset.test.tsx`'s header for why GLB is the
 * engine-free fixture of choice for the federated branch). B's `loadFile`
 * bumps `loadSessionRef` as its very first statement, before any `await` —
 * so by the time A resumes from its held alignment call, its captured
 * session is stale by construction, not by timing luck.
 *
 * **How the alignment await is held open deterministically.** Both CRS names
 * (`EPSG:9999901` / `EPSG:9999902`) are fabricated codes that do not exist in
 * the bundled 7000+-entry EPSG index, so `resolveProjection`
 * (`lib/geo/reproject.ts`) falls through every offline resolution step (grid
 * cache — short-circuited under `NODE_TEST_CONTEXT` — bundled index,
 * well-known-name table, UTM heuristic) to its LAST resort: a real
 * `fetch('https://epsg.io/<code>.proj4')`. `fetch` is a true global (not an
 * ESM named export this repo can't monkeypatch — see
 * `ExtensionHostProvider.tsx`'s header on why `mock.module` is rejected
 * here), so the test overrides `globalThis.fetch` with a promise it controls
 * and waits on a signal that fetch was actually called, never a tick count.
 * Releasing the held fetch with a rejection sends `alignGeometryToReference`
 * down its ordinary `status: 'failed'` return path — the exact shape a
 * genuine reprojection failure takes in production — so the guard is
 * exercised on a real, only-slightly-contrived control-flow outcome, not a
 * fake one.
 *
 * **Why `georefMutations`, not a hand-built STEP/IFCX georeference.** GLB's
 * own `dataStore` carries no IFC entities (`createMinimalGlbDataStore`
 * builds an entity-less store), so it cannot carry a
 * `IfcMapConversion`/`IfcProjectedCRS` pair on its own. `finalizeModel`
 * merges the dataStore's (here: absent) georeference with
 * `useViewerStore`'s per-model `georefMutations` map
 * (`extractModelGeoref(dataStore, coordinateInfo, georefMutations.get(modelId))`),
 * and `mergeProjectedCRS`/`mergeMapConversion`
 * (`lib/geo/effective-georef.ts`) build a complete `ProjectedCRS`/
 * `MapConversion` from the mutation alone when the dataStore has none. This
 * is the same store action a user's manual georef edit (`GeoreferencingPanel`)
 * drives — not a test-only backdoor — seeded directly here only because
 * constructing a real STEP/IFCX `IfcMapConversion` fixture would need either
 * the STEP-text route (`kmz-export.test.ts`'s `storeFromIfc`, IFC2X3/IFC4
 * entities the IFCX ECS model does not speak) or an unreachable WASM engine,
 * neither of which is what this guard's placement depends on: only that
 * `finalizeModel` sees a non-null `parsedGeoref` AND `referenceGeoref` and
 * therefore takes the cross-CRS `await` branch.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore, type FederatedModel } from '@/store';
import { createMinimalGlbDataStore } from './ingest/viewerModelIngest.js';
import { createCoordinateInfo } from '../utils/localParsingUtils.js';
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
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [
      {
        pbrMetallicRoughness: { baseColorFactor: [0.7, 0.7, 0.7, 1.0], metallicFactor: 0, roughnessFactor: 1 },
        extensions: { KHR_materials_unlit: {} },
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5125, count: 3, type: 'SCALAR' },
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

function glbFile(name: string, expressId: number): File {
  return new File([buildGLB(expressId) as BlobPart], name, { type: 'model/gltf-binary' });
}

// ─── Harness ────────────────────────────────────────────────────────────

let hookApi: ReturnType<typeof useIfcLoader> | null = null;

function Probe(): null {
  hookApi = useIfcLoader();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let origFetch: typeof globalThis.fetch;

beforeEach(async () => {
  hookApi = null;
  origFetch = globalThis.fetch;
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
  globalThis.fetch = origFetch;
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  if (container) container.remove();
  container = null;
});

describe('useIfcLoader — a superseded federated add must not overwrite the store after its alignment await (#stale-guard-after-await sweep)', () => {
  it('load A (federated, cross-CRS alignment held open) resolving after load B (primary GLB) has published must not register A', async () => {
    // Seed the federation anchor: an already-loaded model with a real,
    // resolvable georef under a distinct CRS. `findReferenceGeorefModel`
    // reads this straight off the store.
    const refModel: FederatedModel = {
      id: 'ref-model',
      name: 'anchor.glb',
      ifcDataStore: createMinimalGlbDataStore(new ArrayBuffer(0), 0),
      geometryResult: {
        meshes: [],
        totalVertices: 0,
        totalTriangles: 0,
        coordinateInfo: createCoordinateInfo({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }),
      },
      visible: true,
      collapsed: false,
      schemaVersion: 'IFC4',
      loadedAt: 1,
      fileSize: 0,
      idOffset: 0,
      maxExpressId: 0,
    };
    useViewerStore.getState().addModel(refModel);
    useViewerStore.setState({
      georefMutations: new Map([
        ['ref-model', {
          projectedCRS: { name: 'EPSG:9999902', mapUnit: 'METRE', mapUnitScale: 1 },
          mapConversion: { eastings: 1000, northings: 2000, orthogonalHeight: 0, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 },
        }],
        ['model-a', {
          projectedCRS: { name: 'EPSG:9999901', mapUnit: 'METRE', mapUnitScale: 1 },
          mapConversion: { eastings: 500, northings: 800, orthogonalHeight: 0, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 },
        }],
      ]),
    } as Partial<ReturnType<typeof useViewerStore.getState>>);

    // Hold `fetch` open — the real, only-remaining async boundary
    // `alignGeometryToReference`'s cross-CRS path reaches for these two
    // fabricated, not-in-the-bundled-index EPSG codes.
    let resolveHold!: () => void;
    const held = new Promise<Response>((_resolve, reject) => {
      resolveHold = () => reject(new Error('network unavailable (test)'));
    });
    let resolveFetchCalled!: () => void;
    const fetchCalled = new Promise<void>((resolve) => {
      resolveFetchCalled = resolve;
    });
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      resolveFetchCalled();
      return held;
    }) as typeof fetch;

    const fileA = glbFile('federated-race.glb', 7);

    let pendingA!: Promise<void>;
    await act(async () => {
      pendingA = hookApi!.loadFile(fileA, { kind: 'federated', modelId: 'model-a' });
      // Deterministically wait until load A's alignment has actually reached
      // (and started awaiting) the network fallback, rather than guessing a
      // microtask-tick count.
      await fetchCalled;
    });

    // Load B: a real, complete PRIMARY load — bumps `loadSessionRef` as its
    // very first statement, before any await, and publishes its own
    // geometry. This is the exact moment load A becomes superseded.
    const fileB = glbFile('winner.glb', 111);
    await act(async () => {
      await hookApi!.loadFile(fileB);
    });

    const geometryAfterB = useViewerStore.getState().geometryResult;
    assert.ok(geometryAfterB, 'load B must have published its own geometry');
    assert.equal(geometryAfterB!.meshes[0]?.expressId, 111, 'the published primary geometry is load B\'s');
    assert.equal(
      useViewerStore.getState().models.has('model-a'),
      false,
      'sanity: load A must not have registered before B completed — otherwise this test is not driving the race it claims to',
    );

    // Load A's alignment fetch finally rejects — its (now-stale) finalize
    // resumes and, on the buggy code, unconditionally offsets its mesh ids,
    // registers itself in the federation registry, and adds itself to the
    // store.
    await act(async () => {
      resolveHold();
      await pendingA;
    });

    assert.equal(
      useViewerStore.getState().models.has('model-a'),
      false,
      'load A was superseded before its alignment resolved — it must not register itself in the store',
    );
    // The primary slot (load B) must survive load A's discarded finalize
    // exactly as it was. (The anchor model itself is legitimately cleared by
    // B's own primary-load reset — `loadFile`'s `if (target.kind ===
    // 'primary') { ...; clearAllModels(); }` — which is unrelated to the
    // guard under test here.)
    assert.equal(useViewerStore.getState().geometryResult, geometryAfterB, "load B's geometry must be untouched by A's discarded finalize");
  });
});
