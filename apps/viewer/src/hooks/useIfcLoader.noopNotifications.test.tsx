/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { useRef } from 'react';
import { IfcCreator } from '@ifc-lite/create';
import type { PointCloudAsset } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { usePointCloudSync } from '@/components/viewer/usePointCloudSync';
import { render, cleanup } from '@/test/render.js';
import { hook, skip } from '@/test/blank-ifc-loader-harness.js';

it('NEW-2: instrument a real streamed IFC load and its point-cloud subscriber writes', { skip }, async (t) => {
  assert.ok(hook);
  // Only the GPU transport is absent. The real sync hook consumes the real
  // loader's changing geometryResult and reports the assets actually handed in.
  let assets: ReadonlyArray<PointCloudAsset> = [];
  const renderer = {
    isReady: () => true,
    setPointClouds: (next: ReadonlyArray<PointCloudAsset>) => { assets = next; },
    getPointCloudAssetCount: () => assets.length,
    setPointCloudOptions() {}, setEdlOptions() {}, requestRender() {},
  } as unknown as Renderer;
  const Sync = () => {
    const result = useViewerStore(s => s.geometryResult);
    const rendererRef = useRef<Renderer | null>(renderer);
    usePointCloudSync({ rendererRef, isInitialized: true, pointClouds: result?.pointClouds, hasMeshes: !!result?.meshes.length });
    return null;
  };
  const noops = new Map<string, number>();
  let streamed = false;
  let notifications = 0;
  const unsubscribe = useViewerStore.subscribe((state, previous) => {
    notifications++;
    streamed ||= state.geometryStreamingActive;
    const changed = (Object.keys(state) as (keyof typeof state)[]).some(key =>
      typeof state[key] !== 'function' && !Object.is(state[key], previous[key]));
    if (!changed) {
      const stack = new Error().stack ?? '';
      const action = stack.match(/(?:Object\.)?((?:set|clear|reset|append)\w+)\s*\(/)?.[1] ?? 'unattributed';
      noops.set(action, (noops.get(action) ?? 0) + 1);
    }
  });
  try {
    render(<Sync />);
    const creator = new IfcCreator({ Name: 'Stream no-op regression' });
    const storey = creator.addIfcBuildingStorey({ Name: 'Level', Elevation: 0 });
    creator.addIfcWall(storey, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
    await hook.loadFile(new File([creator.toIfc().content], 'stream-noops.ifc'));
    assert.ok(streamed, 'the actual loader entered streaming');
    assert.ok(notifications > 0, 'real updates still publish');
    assert.equal(noops.get('setPointCloudAssetCount') ?? 0, 0);
    assert.equal(noops.get('setPointCloudClassCounts') ?? 0, 0);
    t.diagnostic(`Remaining no-op notifications on real wall load (not a Holter estimate): ${JSON.stringify(Object.fromEntries(noops))}`);
  } finally {
    unsubscribe();
    cleanup();
  }
});
