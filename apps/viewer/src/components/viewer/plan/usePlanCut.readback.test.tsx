/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10887 r4647239305: a plan cut over released geometry that failed because its backing was not sealed
 * yet runs again once the backing seals, with no other change, as the section caps and PDF source do.
 */

import 'fake-indexeddb/auto';
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { StoreApi } from 'zustand';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render.js';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { activeGeometryBackingTap, geometryBackingCommand } from '@/lib/geometry-backing/backing-debug-hook';
import type { TapState } from '@/lib/geometry-backing/store-backing-tap';
import { PLAN_CUT_DEBOUNCE_MS, PLAN_CUT_HEIGHT, usePlanCutDrawing, type PlanCutResult } from './usePlanCut';

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, PLAN_CUT_DEBOUNCE_MS + 250)));

/** An axis-aligned box in render space (Y up), as 12 triangles. */
function box(expressId: number, min: [number, number, number], max: [number, number, number]): MeshData {
  const c = (i: number): [number, number, number] => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const positions = new Float32Array(Array.from({ length: 8 }, (_, i) => c(i)).flat());
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const indices = new Uint32Array(quads.flatMap(([a, b, cc, d]) => [a, b, cc, a, cc, d]));
  return { expressId, positions, normals: new Float32Array(positions.length), indices, color: [1, 1, 1, 1], ifcType: 'IfcWall' } as MeshData;
}

afterEach(() => cleanup());

it('#10887 r4647239305 a plan cut that failed before its backing sealed succeeds once it seals, with no other change', async () => {
  const meshes = [box(90, [0, 0, -0.2], [4, 3, 0])]; // a 4 m wall, 3 m tall
  useViewerStore.setState({ models: new Map([['pc', { id: 'pc', idOffset: 0, maxExpressId: 100, geometryResult: { meshes } }]]) } as never);
  const store = useViewerStore as unknown as StoreApi<TapState>;
  try {
    await geometryBackingCommand(store, undefined, { action: 'start', options: { database: { name: `plan-cut-seal-${process.pid}`, locks: null } } as never });
    await activeGeometryBackingTap()!.whenIdle(); // every record written while the arrays were resident
    releaseCpuMeshBuffers(meshes); // released BEFORE the backing is sealed
    const request = { scope: 'pc', key: 'pc:0', meshes, cutY: PLAN_CUT_HEIGHT, map: (x: number, z: number): [number, number] => [x, -z] };
    let seen: PlanCutResult | undefined;
    function Probe() { seen = usePlanCutDrawing(request); return null; }
    render(<Probe />);
    await settle();
    assert.equal(seen?.failed, true, 'no sealed backing answers yet: the cut fails');
    await act(async () => { await geometryBackingCommand(store, undefined, { action: 'seal' }); });
    await settle();
    await settle();
    assert.equal(seen?.failed, false, 'the cut ran again on its own once the backing sealed');
    assert.ok((seen?.lines.length ?? 0) > 0, 'and draws the wall from the backing');
  } finally {
    await geometryBackingCommand(store, undefined, { action: 'stop' });
  }
});
