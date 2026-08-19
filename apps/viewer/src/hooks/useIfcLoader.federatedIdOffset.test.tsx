/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pins the WRITE side of the federation id-offset — `useIfcLoader.ts`'s
 * `finalizeModel` federated branch:
 *
 *   const idOffset = registerModelOffset(modelId, maxExpressId);
 *   if (idOffset > 0) {
 *     for (const mesh of geometryResult.meshes) {
 *       mesh.expressId = mesh.expressId + idOffset;
 *       ...
 *
 * #2704 fixed the READ side of a double-offset defect: a consumer that added
 * `idOffset` a second time on top of ids the loader had already shifted.
 * `useClash.federated-id-offset.test.tsx` guards that consumer, but it
 * hand-builds its `FederatedModel` fixture ALREADY shifted "as `useIfcLoader`
 * leaves it" — it can prove the consumer behaves correctly given a properly
 * shifted mesh, but it cannot prove the loader is what produced that shift.
 * Nothing else in this suite calls the real `loadFile` with
 * `target.kind === 'federated'`: the three direct `useIfcLoader.*.test.tsx`
 * files all use the default `{ kind: 'primary' }`, and
 * `useIfcFederation.ifcxBuffers.test.tsx` / `useIfcFederation.resetState.test.tsx`
 * inject a hand-written fake `loadFile` into `useIfcFederation`, so they never
 * run the real branch either. Reverting the line above to
 * `mesh.expressId + idOffset * 2` — reintroducing the exact defect #2704
 * fixed — left all of them green (verified: 10/10 across the six files this
 * comment names, PR description has the count breakdown). This file closes
 * that gap by driving the real `useIfcLoader().loadFile` with a real
 * federated target and asserting the exact resulting expressId.
 *
 * **Why GLB, not a STEP/IFC primary + federated pair.** The federated branch
 * of `finalizeModel` is reachable through three formats: STEP/IFC (cache,
 * server, or local WASM tessellation), IFCX (client-side JSON parse), and GLB
 * (client-side binary parse, `parseGlbViewerModel` → `loadGLBToMeshData`).
 * Cache and server loads are PRIMARY-ONLY (`useIfcLoader.ts`, "Cache + server
 * are PRIMARY-ONLY: a federated add is WASM-only"), so a federated add always
 * takes local parsing — WASM tessellation for STEP/IFC, no engine at all for
 * IFCX/GLB. The WASM engine cannot initialize under this test harness: on
 * Node, `IfcLiteBridge.init()` has a `fs.readFile`-based fallback that skips
 * the browser `fetch()`, gated on `typeof window === 'undefined'` — but this
 * suite's `setup-dom.js` installs `happy-dom`, which defines `window`, so the
 * bridge takes the browser fetch path and dies on `file://` (confirmed by
 * running `useIfcLoader.sabStreaming.test.tsx`, whose own comment documents
 * the same wall: "Node has no fetchable WASM engine"). GLB needs no WASM and
 * no ECS composition — `loadGLBToMeshData` reads `node.extras.expressId`
 * straight off a binary glTF buffer — so it is the real, un-faked seam that
 * reaches `finalizeModel`'s federated branch without the engine.
 *
 * **What is real and what is seeded.** `loadFile(file, { kind: 'federated',
 * modelId, ... })` is the actual production entry point, unmodified, and
 * every step from format detection through `finalizeModel`'s offset
 * application runs for real. The one thing seeded directly is the federation
 * registry's starting offset: production reaches a NON-ZERO `idOffset` only
 * once some earlier model has already registered an id range (typically a
 * primary STEP/IFC load, which registers for real — GLB is the one primary
 * format that does NOT register: `finalizeModel`'s primary branch passes
 * `dataStore: null` for a primary GLB, so its
 * `if (dataStore && geometryResult) { ... registerModelOffset(...) }` guard
 * never fires). Reproducing that earlier registration through a real primary
 * load would need either the same unreachable WASM engine (STEP/IFC) or a
 * hand-composed IFCX ECS/USD fixture (points, face-vertex indices, a
 * composition layer) whose complexity is orthogonal to what this test pins —
 * and `registerModelOffset` itself is already covered by
 * `packages/renderer/src/federation-registry.test.ts`, so re-deriving it here
 * would only duplicate that coverage while adding an unrelated fixture.
 * Instead this test calls the SAME store action — `registerModelOffset`,
 * `useViewerStore`'s real federation-registry entry point, not a stub of it —
 * directly, exactly as a real primary load's `finalizeModel` would, to seed
 * "a primary model already occupying ids 0..1000". From that point on, the
 * model actually under test (the federated GLB) goes through `loadFile` for
 * real, and the offset it receives, and the shift it applies to
 * `mesh.expressId`, are the real production computation.
 *
 * **What remains unverified.** Whether a REAL primary load's own
 * `registerModelOffset` call (the one inside `finalizeModel`'s primary
 * branch, for STEP/IFC or IFCX) wires its `maxExpressId` correctly is not
 * checked here — only that a federated load, given a registered offset,
 * applies it correctly to its own meshes. That first link is a much smaller
 * surface (`getMaxExpressId(dataStore, meshes)` feeding a single
 * `registerModelOffset` call, identical in the primary and federated
 * branches) and is not the one #2704 was about.
 *
 * **An unrelated defect surfaces on this exact call, and is deliberately not
 * asserted on.** `loadFile` logs `console.error('[useIfc] GLB parsing
 * failed:', err)` and this test's run prints a
 * `ReferenceError: Cannot access 'allInstancedShards' before initialization`
 * at `finalizeModel` (useIfcLoader.ts:632). `allInstancedShards` is a `const`
 * declared at useIfcLoader.ts:1443, inside the LOCAL-WASM-ONLY section of
 * `loadFile` that only STEP/IFC reaches; `finalizeModel`'s federated branch
 * closes over that same binding, so ANY federated add that reaches
 * `finalizeModel` without first passing through that section — every GLB,
 * IFCX, or point-cloud federated add, not merely this test's fixture — hits
 * the same TDZ crash. It is thrown from the LAST statement in the federated
 * branch (`if (allInstancedShards.length > 0) { appendInstancedShards(...) }`,
 * useIfcLoader.ts:632-634), which runs AFTER `registerModelOffset`, the
 * `mesh.expressId` shift, and `addModel` have already completed — so the
 * model this test inspects already carries the correct (or incorrect, under
 * mutation) offset by the time the exception fires, and the exception itself
 * does not touch the code this test pins. The `catch` block then marks the
 * model `loadState: 'error'` over data that in fact loaded correctly. This is
 * a real, pre-existing, unrelated production bug — confirmed by reading the
 * unmodified `upstream/main` source, not an artifact of this harness — and is
 * out of scope here per this task's "test addition only" constraint; it is
 * reported separately rather than fixed or masked.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore, type FederatedModel } from '@/store';
import { useIfcLoader } from './useIfcLoader.js';

// ─── A real, minimal GLB fixture ───────────────────────────────────────────

/**
 * One triangle, one node, one mesh, carrying `extras.expressId` — the exact
 * shape `GLTFExporter` produces and `loadGLBToMeshData` reads
 * (`packages/cache/src/glb.ts`), mirrored from the fixture builder in
 * `packages/cache/src/glb.test.ts`. A real binary glTF buffer, not a stand-in:
 * `detectFormat` routes it via the `0x46546C67` magic bytes, and
 * `parseGlbViewerModel` parses it with the same code a real GLB import uses.
 */
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

describe('useIfcLoader — the federation id-offset WRITE side (producer half of #2704)', () => {
  it('shifts a federated model\'s mesh.expressId by exactly the registered offset — not doubled, not unshifted', async () => {
    // Seed "a primary model already registered ids 0..1000" via the real
    // store action `registerModelOffset` (see file header for why this is
    // seeded rather than driven through a real primary load).
    const seededOffset = useViewerStore.getState().registerModelOffset('seed-primary', 1000);
    assert.equal(seededOffset, 0, 'sanity: the seed must be the FIRST registration, or the offset below is not the one this test controls');

    // Chosen so `local`, `local + offset`, and `local + 2*offset` are three
    // unambiguous numbers: offset will be 1001 (seed's maxExpressId 1000 + 1
    // gap), local is 42, so correct = 1043, doubled-defect = 2044, unshifted = 42.
    const localExpressId = 42;
    const file = glbFile('federated-fixture.glb', localExpressId);

    await act(async () => {
      await hookApi!.loadFile(file, {
        kind: 'federated',
        modelId: 'federated-model',
      });
    });

    const model = useViewerStore.getState().models.get('federated-model') as FederatedModel | undefined;
    assert.ok(model, 'loadFile must have registered the federated model — otherwise it never reached finalizeModel and the assertions below are vacuous');
    assert.ok(model.geometryResult, 'the federated model must carry a geometryResult');
    assert.equal(model.geometryResult!.meshes.length, 1, 'the fixture GLB carries exactly one mesh');

    const mesh = model.geometryResult!.meshes[0]!;

    assert.equal(model.idOffset, 1001, 'the registered offset itself must be 1001 (seed maxExpressId 1000 + 1 gap) — if this fails, the seed setup changed, not the code under test');

    // The three-direction discrimination this file exists to provide:
    assert.equal(
      mesh.expressId,
      localExpressId + model.idOffset,
      `mesh.expressId must be local (${localExpressId}) + idOffset (${model.idOffset}) = ${localExpressId + model.idOffset} — `
      + 'the correct, single-application shift',
    );
    assert.notEqual(
      mesh.expressId,
      localExpressId + 2 * model.idOffset,
      `mesh.expressId must NOT be local + 2*idOffset (${localExpressId + 2 * model.idOffset}) — `
      + 'that is the exact double-offset defect #2704 fixed on the read side; this pins the write side never reintroduces it',
    );
    assert.notEqual(
      mesh.expressId,
      localExpressId,
      `mesh.expressId must NOT be left unshifted at ${localExpressId} — `
      + 'an unshifted federated mesh collides with the primary model\'s id space',
    );
  });
});
