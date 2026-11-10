/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act, useRef } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { recoveryAllocationDevice } from '@/test/recovery-allocation-device';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import { useViewerStore } from '@/store';
import { render, cleanup } from '@/test/render';
import { useGeometryStreaming } from './useGeometryStreaming';

it('#9296 first authored geometry leaves the camera where the user put it', async () => {
  await seedModelingSession();
  useViewerStore.getState().enterModelWorkspace();
  const allocation = recoveryAllocationDevice();
  const renderer = new Renderer(allocation.canvas);
  const noop = () => {};
  const geometry: MeshData[] = [{ expressId: 42, positions: new Float32Array([0,0,0,4,0,0,0,3,0]),
    normals: new Float32Array([0,0,1,0,0,1,0,0,1]), indices: new Uint32Array([0,1,2]), color: [1,1,1,1] }];
  function Probe() {
    const version = useViewerStore((s) => s.mutationVersion);
    const rendererRef = useRef<Renderer | null>(renderer);
    const geometryBoundsRef = useRef({ min: { x: 0,y: 0,z: 0 }, max: { x: 4,y: 3,z: 0 } });
    const clearColorRef = useRef<[number,number,number,number]>([0,0,0,1]);
    useGeometryStreaming({ rendererRef, geometry, geometryReplacementVersion: version, isInitialized: true, isStreaming: false, modelCount: 1,
      geometryBoundsRef, clearColorRef, pendingMeshColorUpdates: null, pendingColorUpdates: null,
      pendingMeshRemovals: null, pendingMeshTranslations: null, pendingMeshRotations: null, pendingInstancedShards: null,
      clearPendingMeshColorUpdates: noop, clearPendingColorUpdates: noop, clearPendingMeshRemovals: noop,
      pruneGeometryMeshes: noop, clearPendingMeshTranslations: noop, clearPendingMeshRotations: noop, clearInstancedShards: noop });
    return null;
  }
  try {
    await renderer.init();
    const camera = renderer.getCamera(); camera.setPosition(12,15,20);
    const before = { position: {...camera.getPosition()}, target: {...camera.getTarget()} };
    render(<Probe />);
    assert.deepEqual({ position: {...camera.getPosition()}, target: {...camera.getTarget()} }, before);
    act(() => { useViewerStore.getState().exitModelWorkspace(); useViewerStore.setState({ mutationVersion: 1 }); });
    assert.deepEqual({ position: {...camera.getPosition()}, target: {...camera.getTarget()} }, before, "leaving authoring cannot arm a delayed auto-fit");
  } finally { cleanup(); renderer.destroy(); allocation.restore(); useViewerStore.getState().exitModelWorkspace(); }
});
