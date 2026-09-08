/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stale-guard-after-await sweep: `useIfcLoader.ts`'s IFCX branch.
 *
 *   const result = await parseIfcxViewerModel(buffer, setProgress);
 *   if (target.kind === 'primary') {
 *     setGeometryResult(result.geometryResult);
 *     setIfcDataStore(result.dataStore);
 *   }
 *   await finalizeModel(result.dataStore, result.geometryResult, result.schemaVersion);
 *
 * `parseIfcxViewerModel` is the only await in this branch, and — unlike
 * every sibling branch in this same function (the cache branch's
 * `if (cacheOutcome === 'stale') return;`, the point-cloud branch's
 * `if (loadSessionRef.current !== currentSession) { ...unwind...; return; }`,
 * and the server branch, which delegates its own internal re-checks to
 * `loadFromServer`'s `isStale` predicate) — this branch had NO re-check that
 * a newer load (or model removal) hadn't superseded this one while the parse
 * was in flight. `finalizeModel` itself provides no protection either: none
 * of its internal writes (`addModel`, `buildSpatialIndexForModel`,
 * `appendInstancedShards`, `updateModel`) re-check the session — tracing
 * confirmed zero `loadSessionRef` references inside its body. So a
 * superseded IFCX parse landing late used to overwrite whatever a newer,
 * already-displayed load had published, unconditionally.
 *
 * Concrete interleaving this drives: load A (an IFCX file whose buffer read
 * this test holds open) is in progress when the user picks a different file,
 * load B (a GLB, parsed and finalized synchronously — no engine needed, see
 * `useIfcLoader.federatedIdOffset.test.tsx`'s header for why GLB is the
 * engine-free fixture of choice here). B completes and its geometry is the
 * current store state. A's (real, successful) IFCX parse then resolves late;
 * on the buggy code A's stale, empty-geometry result overwrites B's
 * already-published geometry in the store even though B is what the user
 * asked for and is looking at.
 *
 * **Deterministic interleaving, not a tick count.** `loadFile`'s session bump
 * (`++loadSessionRef.current`) is its very first statement, before any
 * `await` (see `useIfcLoader.cacheStaleness.test.tsx`'s header for the same
 * reasoning) — so firing `loadFile(fileB)` to completion while `loadFile(fileA)`
 * is deliberately parked on a held promise leaves `fileA`'s captured session
 * stale by construction, not by timing luck. The hold point is `fileA`'s own
 * `File#arrayBuffer()` (the read `acquireFileBuffer` performs for a
 * sub-threshold file) rather than `parseIfcxViewerModel` itself:
 * `parseIfcxViewerModel` → `parseIfcx` is real, synchronous JSON/ECS work
 * wrapped in an `async` function with no internal `await` at all, so there is
 * no way to suspend it mid-flight the way `useIfcServer.stale-guard.test.tsx`
 * suspends `parseParquet` (a real network round trip). Holding the file read
 * instead achieves the identical race shape: the session flips strictly
 * between `fileA`'s last await and the write the fix guards, which is the
 * property that matters, not which specific await carries it.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { useIfcLoader } from './useIfcLoader.js';

// ─── A real, minimal GLB fixture (load B — the winning load) ──────────────
// Mirrors useIfcLoader.federatedIdOffset.test.tsx's fixture builder exactly:
// one triangle, one node, carrying `extras.expressId`, routed via
// `detectFormat`'s `0x46546C67` magic-byte check and parsed for real by
// `parseGlbViewerModel` — no WASM engine required.
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

// ─── A real, minimal IFCX fixture (load A — the superseded load) ──────────
// Valid enough for `parseIfcx` to succeed (a recognized `header.ifcxVersion`,
// zero entities so the "overlay-only-ifcx" empty-geometry guard doesn't
// fire) while carrying no geometry of its own — its content is irrelevant to
// the race, only that it parses successfully and would (on the buggy code)
// land a real, distinct write.
function ifcxFile(name: string): File {
  const json = {
    header: { id: 'h', ifcxVersion: 'ifcx-alpha', dataVersion: '1', author: 't', timestamp: '' },
    imports: [],
    schemas: {},
    data: [],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  return new File([bytes as BlobPart], name, { type: 'application/json' });
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

describe('useIfcLoader — a superseded IFCX load must not overwrite the newer geometry (#stale-guard-after-await sweep)', () => {
  it('load A (IFCX, held open) resolving after load B (GLB) has published must not clobber B\'s geometry', async () => {
    const fileA = ifcxFile('race.ifcx');
    const realBuffer = await fileA.arrayBuffer(); // capture real bytes before shadowing the method

    let resolveHold!: (buf: ArrayBuffer) => void;
    const held = new Promise<ArrayBuffer>((resolve) => {
      resolveHold = resolve;
    });
    let resolveCalled!: () => void;
    const arrayBufferCalled = new Promise<void>((resolve) => {
      resolveCalled = resolve;
    });
    // Shadow ONLY this instance's `arrayBuffer()` — the method
    // `acquireFileBuffer` awaits for a sub-threshold file. `file.slice(...)`
    // (the earlier point-cloud-detection head read) returns a fresh `Blob`
    // unaffected by this instance-level override, so format sniffing still
    // sees the real header bytes.
    fileA.arrayBuffer = () => {
      resolveCalled();
      return held;
    };

    const fileB = glbFile('winner.glb', 777);

    let pendingA!: Promise<void>;
    await act(async () => {
      pendingA = hookApi!.loadFile(fileA);
      // Deterministically wait until load A has actually reached (and
      // started awaiting) the file read, rather than guessing a
      // microtask-tick count.
      await arrayBufferCalled;
    });

    // Load B: a real, complete primary load that bumps `loadSessionRef`
    // (its very first statement, before any await) and publishes its own
    // geometry — the exact moment load A becomes superseded.
    await act(async () => {
      await hookApi!.loadFile(fileB);
    });

    const geometryAfterB = useViewerStore.getState().geometryResult;
    assert.ok(geometryAfterB, 'load B must have published geometry');
    assert.equal(geometryAfterB!.meshes.length, 1, 'load B (GLB) published its one triangle');
    assert.equal(geometryAfterB!.meshes[0].expressId, 777, 'the published mesh is load B\'s, not a stale placeholder');

    // Load A's file read finally resolves — its IFCX parse now runs and
    // (on the buggy code) unconditionally overwrites the store.
    await act(async () => {
      resolveHold(realBuffer);
      await pendingA;
    });

    const geometryFinal = useViewerStore.getState().geometryResult;
    assert.equal(
      geometryFinal,
      geometryAfterB,
      'load A was superseded before its IFCX parse resolved — its result must not replace ' +
        "load B's already-published geometry",
    );
  });
});
