/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2073: `scene.clear()` used to run unconditionally on every non-streaming
 * reshape (`useGeometryStreaming.ts`'s main effect: a fresh/replaced file, a
 * length-decrease from hiding a model or a type-visibility toggle, a
 * federated model add, an in-place content-version bump). That destroys
 * EVERY GPU-instanced template — including ones belonging to a model that is
 * still loaded and visible — and nothing re-uploads them afterwards: the raw
 * IFNS shard bytes are dropped from the store right after their one-time
 * drain (`clearInstancedShards()` / `pendingInstancedShards: null`), so
 * repeated geometry (windows, doors, bolts, ...) silently vanished for the
 * rest of the session on the very next reshape.
 *
 * This drives the REAL `useGeometryStreaming` hook under happy-dom + React
 * 19, with a fake `Renderer`/`Scene`/`Camera` (no WebGPU needed — the hook
 * only calls a small, enumerable surface of methods on them) that records
 * every call AND tracks which `modelIndex`es currently own instanced
 * templates, the same way the real `Scene` class does. `decodeInstancedShard`
 * is the REAL function from `@ifc-lite/geometry`, fed a known-good fixture
 * (borrowed from `packed-instanced-decoder.test.ts`), so the shard-drain
 * effect exercises real decode, not a stub.
 *
 * Two invariants are asserted, matching the issue's design requirement:
 *  1. A reshape where the model is STILL present must retain its instanced
 *     geometry (the bug: it did not).
 *  2. A reshape where the model was hidden/removed must NOT retain its
 *     instanced geometry (the naive "just don't clear" fix the issue's own
 *     design comment rejected, because the scene/hook couldn't tell WHICH
 *     model a template belonged to before #2172's per-model ownership +
 *     #2239's bbox teardown landed).
 */

import '../../test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useRef, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { useGeometryStreaming, type UseGeometryStreamingParams } from './useGeometryStreaming.js';

// ── Known-good decodable instanced-shard fixture ───────────────────────────
// Same bytes as packages/geometry/src/packed-instanced-decoder.test.ts's
// Rust↔TS conformance fixture (`dump_instanced_fixture`): 2 templates, 3
// instances. Content doesn't matter here — only that `decodeInstancedShard`
// accepts it without throwing, so the hook's real drain path runs end to end.
const SHARD_FIXTURE_HEX =
  '534e464901000000020000000300000018000000180000000800000000000000000000000c000000000000000c00000000000000040000000000000000000000000000000000000000000000000000000c0000000c0000000c0000000c000000040000000400000000000000000000000000000000000000000000000000000000000000e803000000000000cdcc4c3e9a99993e0000803f0000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f00000000e9030000cdcccc3dcdcc4c3e9a99993e0000803f0000803f0000000000000000000080bf000000000000803f000000000000004000000000000000000000803f000000000000000000000000000000000000803f01000000ea030000cdcc4c3ecdcc4c3e9a99993e0000803f0000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f0000803f00000000000000000000004000000000000000000000803f0000803f000000000000803f000000000000803f0000a0400000a0400000a0400000c0400000a0400000a0400000a0400000c0400000a0400000a0400000a0400000c0400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000020000000300000000000000010000000200000003000000';

function hexToShardBytes(hex: string): ArrayBuffer {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out.buffer;
}

const SHARD_BYTES = hexToShardBytes(SHARD_FIXTURE_HEX);

function mesh(expressId: number, modelIndex = 0): MeshData {
  return {
    expressId,
    modelIndex,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  };
}

// ── Fake Scene: records every call the hook makes, and tracks which
//    modelIndexes currently own instanced templates the same way the real
//    Scene class does (add on addInstancedShard, drop-all on clear(),
//    drop-one on removeInstancedTemplatesForModel(), untouched by
//    clearFlatGeometry()). ──────────────────────────────────────────────────
class FakeScene {
  calls: string[] = [];
  instancedModelIndices = new Set<number>();

  clear(): void {
    this.calls.push('clear');
    this.instancedModelIndices.clear();
  }
  clearFlatGeometry(): void {
    this.calls.push('clearFlatGeometry');
    // Flat-only: instanced templates are untouched by design (#2073).
  }
  getInstancedModelIndices(): number[] {
    return [...this.instancedModelIndices];
  }
  removeInstancedTemplatesForModel(modelIndex: number): number {
    this.calls.push(`removeInstancedTemplatesForModel:${modelIndex}`);
    const had = this.instancedModelIndices.delete(modelIndex);
    return had ? 1 : 0;
  }
  addInstancedShard(_device: unknown, _shard: unknown, modelIndex = 0): void {
    this.calls.push('addInstancedShard');
    this.instancedModelIndices.add(modelIndex);
  }
  appendToBatches(): void { this.calls.push('appendToBatches'); }
  queueMeshes(): void { this.calls.push('queueMeshes'); }
  hasQueuedMeshes(): boolean { return false; }
  getBatchedMeshes(): unknown[] { return []; }
  flushPending(): boolean { return true; }
  hasPendingBatches(): boolean { return false; }
  rebuildPendingBatches(): void {}
  removeMeshesForEntities(): void {}
  translateMeshesForEntities(): void {}
  rotateMeshesForEntities(): void {}
  hasStreamingFragments(): boolean { return false; }
  isEphemeralStreaming(): boolean { return false; }
  finalizeStreaming(): void {}
  finalizeStreamingAsync(): Promise<void> { return Promise.resolve(); }
  finishEphemeralStreaming(): void {}
  setEphemeralStreamingMode(): void {}
  updateMeshColors(): void {}
  setColorOverrides(): void {}
  clearColorOverrides(): void {}
}

function fakeCamera() {
  return {
    fitBoundsAdaptive: () => ({ kind: 'compact' as const }),
    getPosition: () => ({ x: 0, y: 0, z: 0 }),
    getTarget: () => ({ x: 0, y: 0, z: 0 }),
    setSceneBounds: () => {},
    setOrbitAnchorBounds: () => {},
    reset: () => {},
  };
}

function fakeRenderer(scene: FakeScene) {
  const camera = fakeCamera();
  return {
    getGPUDevice: () => ({}),
    getPipeline: () => ({}),
    getScene: () => scene,
    getCamera: () => camera,
    getCanvas: () => null,
    clearCaches: () => {},
    requestRender: () => {},
  } as unknown as Renderer;
}

/** Harness: mounts the real hook, letting the test drive its params via
 *  external re-renders. `pendingInstancedShards` is owned INTERNALLY (seeded
 *  once from `initialShardBytes`) so `clearInstancedShards()` behaves exactly
 *  like the real store action — set to null and stay null across later
 *  reshapes, since nothing in this bug scenario ever repopulates it. */
function Harness(props: Omit<UseGeometryStreamingParams, 'pendingInstancedShards' | 'clearInstancedShards' | 'rendererRef' | 'clearColorRef'> & {
  initialShardBytes: ArrayBuffer[] | null;
  renderer: Renderer;
}) {
  const { initialShardBytes, renderer, ...rest } = props;
  const [shards, setShards] = useState<ArrayBuffer[] | null>(() => initialShardBytes);
  const rendererRef = useRef<Renderer | null>(renderer);
  const clearColorRef = useRef<[number, number, number, number]>([0, 0, 0, 1]);
  useGeometryStreaming({
    ...rest,
    rendererRef,
    pendingInstancedShards: shards,
    clearInstancedShards: () => setShards(null),
    clearColorRef,
  });
  return null;
}

type ReshapeOverrides = Pick<
  UseGeometryStreamingParams,
  'geometry' | 'geometryVersion' | 'geometryContentVersion' | 'modelCount' | 'presentInstancedModelIndices'
>;

function baseParams(scene: FakeScene, overrides: ReshapeOverrides) {
  const noop = () => {};
  return {
    isInitialized: true,
    isStreaming: false,
    geometryBoundsRef: { current: { min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } } },
    pendingMeshColorUpdates: null,
    pendingColorUpdates: null,
    pendingMeshRemovals: null,
    pendingMeshTranslations: null,
    pendingMeshRotations: null,
    clearPendingMeshColorUpdates: noop,
    clearPendingColorUpdates: noop,
    clearPendingMeshRemovals: noop,
    clearPendingMeshTranslations: noop,
    clearPendingMeshRotations: noop,
    renderer: fakeRenderer(scene),
    ...overrides,
  };
}

function mountHarness(container: HTMLDivElement): Root {
  return createRoot(container);
}

describe('useGeometryStreaming — instanced-template retention across scene.clear() (#2073)', () => {
  it('retains a still-present model\'s instanced geometry across a non-streaming reshape', () => {
    const scene = new FakeScene();
    const container = document.createElement('div');
    const root = mountHarness(container);

    // Initial load: one model (modelIndex 0), one flat mesh, one instanced
    // shard streamed in alongside it.
    act(() => {
      root.render(
        <Harness
          {...baseParams(scene, {
            geometry: [mesh(1, 0)],
            geometryVersion: 1,
            modelCount: 1,
            presentInstancedModelIndices: new Set([0]),
          })}
          initialShardBytes={[SHARD_BYTES]}
        />
      );
    });

    assert.deepEqual(
      scene.calls,
      ['clearFlatGeometry', 'appendToBatches', 'addInstancedShard'],
      'initial load: flat-geometry clear (no instanced templates exist yet, so the reconcile is a no-op), ' +
      'flat append, instanced shard drain',
    );
    assert.deepEqual([...scene.instancedModelIndices], [0], 'model 0 owns instanced templates after initial load');
    scene.calls.length = 0;

    // Reshape #1: in-place content mutation (e.g. realignFederation) with the
    // SAME model (0) still present — geometryContentVersion bumps. No new
    // shard bytes arrive (pendingInstancedShards stays null, drained once).
    act(() => {
      root.render(
        <Harness
          {...baseParams(scene, {
            geometry: [mesh(1, 0)],
            geometryVersion: 1,
            geometryContentVersion: 1,
            modelCount: 1,
            presentInstancedModelIndices: new Set([0]),
          })}
          initialShardBytes={[SHARD_BYTES]}
        />
      );
    });

    // Shape asserted in the issue: a flat-geometry clear + re-append, and
    // — critically — NO second addInstancedShard (nothing re-uploads the
    // dropped shard bytes). What must differ from the pre-fix behaviour is
    // NOT the call names but the surviving state: model 0's instanced
    // templates must still be there.
    assert.ok(!scene.calls.includes('addInstancedShard'), 'no shard bytes were re-drained (none arrived)');
    assert.deepEqual(
      [...scene.instancedModelIndices],
      [0],
      'RED on unmodified main: scene.clear() destroys every instanced template, including model 0\'s, ' +
      'even though model 0 never left. GREEN once the hook uses clearFlatGeometry() + reconciles ' +
      'ownership against presentInstancedModelIndices instead of a blind clear().',
    );

    act(() => { root.unmount(); });
  });

  it('does NOT retain a hidden/removed model\'s instanced geometry (the case the naive fix breaks)', () => {
    const scene = new FakeScene();
    const container = document.createElement('div');
    const root = mountHarness(container);

    // Initial load: two federated models. Model 0 gets one instanced shard;
    // model 1 gets a second, distinctly-tagged shard (simulated by seeding
    // the fake scene directly at modelIndex 1 — the real per-shard modelIndex
    // tagging is #2255's job, not this hook's; this test only needs the
    // SCENE to already know model 1 owns templates, which #2172 already
    // makes possible via addInstancedShard's modelIndex param).
    act(() => {
      root.render(
        <Harness
          {...baseParams(scene, {
            geometry: [mesh(1, 0), mesh(2, 1)],
            geometryVersion: 1,
            modelCount: 2,
            presentInstancedModelIndices: new Set([0, 1]),
          })}
          initialShardBytes={[SHARD_BYTES]}
        />
      );
    });
    // Seed model 1's instanced ownership directly (see comment above).
    scene.instancedModelIndices.add(1);
    assert.deepEqual([...scene.instancedModelIndices].sort(), [0, 1], 'both models own instanced templates');
    scene.calls.length = 0;

    // Reshape: model 1 is hidden (a type-visibility toggle or a federation
    // hide) — geometry shrinks to just model 0's mesh, and the caller updates
    // presentInstancedModelIndices to reflect that model 1 is no longer
    // present.
    act(() => {
      root.render(
        <Harness
          {...baseParams(scene, {
            geometry: [mesh(1, 0)],
            geometryVersion: 2,
            modelCount: 2,
            presentInstancedModelIndices: new Set([0]),
          })}
          initialShardBytes={[SHARD_BYTES]}
        />
      );
    });

    assert.deepEqual(
      [...scene.instancedModelIndices],
      [0],
      'model 1\'s instanced geometry must be torn down when it is hidden — retaining it would reproduce ' +
      'exactly the bug the original design comment rejected (a hidden model\'s repeated geometry staying ' +
      'on screen because the scene could not tell which template belonged to which model).',
    );
    assert.ok(
      scene.calls.includes('removeInstancedTemplatesForModel:1'),
      `expected an explicit per-model teardown for the removed model, got calls: ${JSON.stringify(scene.calls)}`,
    );
    assert.ok(
      !scene.calls.includes('removeInstancedTemplatesForModel:0'),
      'model 0 (still present) must not be torn down',
    );

    act(() => { root.unmount(); });
  });
});
