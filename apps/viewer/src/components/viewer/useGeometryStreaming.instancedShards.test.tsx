/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Federated instanced-shard delivery (#1912 step 2).
 *
 * `addInstancedShard` (packages/renderer) has taken an owning `modelIndex`
 * since #2172, but the ONE call site — this hook's drain effect — never
 * forwarded it, and the loader only ever pushed the PRIMARY model's shard
 * bytes into `pendingInstancedShards` in the first place. A secondary
 * (federated) model's repeated opaque occurrences therefore never reached
 * the scene: no instanced geometry rendered for anything but the primary.
 *
 * This test drives the hook directly (`useGeometryStreaming` mounted under a
 * bare harness, no real GPU / renderer) with a shard tagged for a SECOND
 * model and asserts:
 *   1. `scene.addInstancedShard` is actually called for it (not silently
 *      dropped), and
 *   2. it is called with that model's `modelIndex`, and
 *   3. the occurrence's entity id has been re-homed by that model's
 *      `idOffset` — the offset `finalizeModel` applies to the model's flat
 *      meshes at finalize (apps/viewer/src/hooks/useIfcLoader.ts) — so the
 *      instanced occurrence's id matches the one selection/highlighting use
 *      for the same entity everywhere else.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Renderer } from '@ifc-lite/renderer';
import type { DecodedInstancedShard } from '@ifc-lite/geometry';
import { useGeometryStreaming, type UseGeometryStreamingParams } from './useGeometryStreaming.js';

import { buildShardBytes } from '@/test/instanced-shard-fixture.js';

interface RecordedCall {
  modelIndex: number | undefined;
  entityIds: number[];
}

function fakeRenderer(calls: RecordedCall[]): Renderer {
  const scene = {
    addInstancedShard: (_device: unknown, shard: DecodedInstancedShard, modelIndex?: number) => {
      calls.push({ modelIndex, entityIds: shard.instances.map((i) => i.entityId) });
    },
  };
  return {
    getGPUDevice: () => ({}) as unknown,
    getScene: () => scene,
    requestRender: () => {},
  } as unknown as Renderer;
}

function baseParams(overrides: Partial<UseGeometryStreamingParams>): UseGeometryStreamingParams {
  return {
    rendererRef: { current: null },
    isInitialized: true,
    geometry: null,
    isStreaming: false,
    geometryBoundsRef: { current: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } } },
    pendingMeshColorUpdates: null,
    pendingColorUpdates: null,
    pendingMeshRemovals: null,
    pendingMeshTranslations: null,
    pendingMeshRotations: null,
    pendingInstancedShards: null,
    clearPendingMeshColorUpdates: () => {},
    clearPendingColorUpdates: () => {},
    clearPendingMeshRemovals: () => {},
    pruneGeometryMeshes: () => {},
    clearPendingMeshTranslations: () => {},
    clearPendingMeshRotations: () => {},
    clearInstancedShards: () => {},
    clearColorRef: { current: [1, 1, 1, 1] },
    ...overrides,
  };
}

function Harness({ params }: { params: UseGeometryStreamingParams }) {
  const rendererRef = useRef(params.rendererRef.current);
  useGeometryStreaming({ ...params, rendererRef });
  return null;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

describe('useGeometryStreaming — federated instanced-shard forwarding (#1912)', () => {
  it('forwards a secondary model\'s shard under its own modelIndex with its id-offset applied', async () => {
    const calls: RecordedCall[] = [];
    const renderer = fakeRenderer(calls);

    const RAW_ENTITY_ID = 42;
    const ID_OFFSET = 5000;
    const params = baseParams({
      rendererRef: { current: renderer },
      pendingInstancedShards: [{ modelId: 'model-b', bytes: buildShardBytes(RAW_ENTITY_ID) }],
      modelIdToIndex: new Map([['model-a', 0], ['model-b', 1]]),
      modelIdToOffset: new Map([['model-a', 0], ['model-b', ID_OFFSET]]),
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    await act(async () => {
      root.render(<Harness params={params} />);
    });

    assert.equal(calls.length, 1, 'scene.addInstancedShard must be called for the secondary model\'s shard');
    assert.equal(calls[0].modelIndex, 1, 'must upload under the secondary model\'s modelIndex, not the primary\'s (0)');
    assert.deepEqual(
      calls[0].entityIds,
      [RAW_ENTITY_ID + ID_OFFSET],
      'the occurrence\'s entity id must carry the model\'s id-offset, matching the id finalizeModel assigned to its flat meshes',
    );
  });
});
