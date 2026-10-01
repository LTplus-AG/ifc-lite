/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: public grid movement must update actual bound-column geometry,
 * not merely its saved placement. Real Bonsai source, mounted plan, real
 * WASM worker body through the remesh-service factory seam; no fake meshes. */
import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { act } from 'react';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import type { MeshData } from '@ifc-lite/geometry';
import { StepExporter } from '@ifc-lite/export';
import { rectangularGridAxes } from '@ifc-lite/create';
import { remeshOnApi, styleWireOnApi } from '../../../../../packages/geometry/src/remesh/remesh-core.js';
import { useViewerStore } from '@/store';
import { fixture, MODEL, STOREY } from '@/test/bonsai-plan-grid-fixture';
import { cleanup, advance } from '@/test/render';
import { addGridColumnIn } from './mutation-grid-column';
import { addGridIn } from './mutation-curtain-grid';
import { requestRemesh, setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { toGlobalIdFromModels } from '@/store/globalId';

const wasmPath = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const wasmAvailable = existsSync(wasmPath);

function centre(meshes: readonly MeshData[], id: number, expectedSize?: readonly number[]): number[] {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  for (const mesh of meshes) {
    if (mesh.expressId !== id) continue;
    const o = mesh.origin ?? [0, 0, 0];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const p = [o[0] + mesh.positions[i], -(o[2] + mesh.positions[i + 2]), o[1] + mesh.positions[i + 1]];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], p[axis]); max[axis] = Math.max(max[axis], p[axis]);
      }
      count++;
    }
  }
  assert.ok(count > 0, 'actual native column has vertices');
  if (expectedSize) close(max.map((v, axis) => v - min[axis]), expectedSize);
  return min.map((v, axis) => (v + max[axis]) / 2);
}

function close(actual: readonly number[], expected: readonly number[]) {
  actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-4,
    `physical axis${axis}: ${value} should equal ${expected[axis]}`));
}

afterEach(() => { cleanup(); setRemeshClientFactory(null); useViewerStore.getState().exitModelWorkspace(); });

for (const count of [1, 2] as const) for (const mm of [false, true]) describe(`#6232 live bound column ${count} Bonsai models/${mm ? 'mm' : 'm'}`, () => {
  for (const movement of ['translate', 'position', 'rotate'] as const) it(`public grid ${movement} updates saved and live physical geometry, then Undo/Redo`, { skip: !wasmAvailable }, async () => {
    const { made } = await fixture(count, { millimetres: mm, rotatedStorey: true, reload: true });
    initSync({ module: readFileSync(wasmPath) });
    const api = new IfcAPI();
    try {
      setRemeshClientFactory(async () => ({
        alive: true, dispose: () => {}, setConfig: () => {},
        styleWire: async (bytes) => styleWireOnApi(api, bytes),
        remesh: async (request) => remeshOnApi(api, request),
      }));
      const state = useViewerStore.getState();
      const model = state.models.get(MODEL)!;
      const geometry = { ...model.geometryResult!, meshes: [], coordinateInfo: {
        ...model.geometryResult!.coordinateInfo!, wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false },
      } };
      const models = new Map(state.models);
      models.set(MODEL, { ...model, geometryResult: geometry });
      useViewerStore.setState({ models, geometryResult: geometry, pendingMeshEdits: null,
        pendingMeshTranslations: null, pendingMeshRotations: null });
      const peerGeometry = models.get('peer')?.geometryResult;
      const added = addGridColumnIn(useViewerStore, MODEL, STOREY, {
        Position: [96, 206, .5], Width: .4, Depth: .2, Height: 3,
      }, { GridId: made.expressId, IntersectingAxes: [made.build.uAxisIds[1], made.build.vAxisIds[1]] });
      assert.ok('expressId' in added, 'real viewer builder accepts the actual crossing');
      let initialStatus: string | undefined;
      await act(async () => { initialStatus = (await requestRemesh(useViewerStore.getState, MODEL, [added.expressId], 'created')).status; });
      assert.equal(initialStatus, 'applied');
      const globalId = toGlobalIdFromModels(useViewerStore.getState().models, MODEL, added.expressId);
      // The Bonsai storey is explicitly translated [1000,2000] native units
      // and rotated90deg. Its grid crossing is storey [96,206,.5] metres.
      const origin = mm ? [1, 2] : [1000, 2000];
      const before = [origin[0] - 206, origin[1] + 96, 2];
      close(centre(useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes, globalId, [.2, .4, 3]), before);
      useViewerStore.setState({ pendingMeshEdits: null });
      act(() => {
        const move = movement === 'translate' ? useViewerStore.getState().translateEntity(MODEL, made.expressId, [1, 0, 0])
          : movement === 'position' ? useViewerStore.getState().setEntityPosition(MODEL, made.expressId, [101, 200, 0])
          : useViewerStore.getState().rotateEntity(MODEL, made.expressId, Math.PI / 2);
        assert.ok(move.ok);
      });
      await advance(30);
      const after = movement === 'rotate' ? [origin[0] - 196, origin[1] + 94, 2]
        : [before[0], before[1] + 1, before[2]];
      const current = useViewerStore.getState();
      const bytes = new StepExporter(model.ifcDataStore!, current.mutationViews.get(MODEL)).export({ schema: 'IFC4', applyMutations: true }).content;
      const saved = remeshOnApi(api, { buffer: bytes, targets: new Uint32Array([added.expressId]),
        frame: { x: 0, y: 0, z: 0, needsShift: false }, ...styleWireOnApi(api, bytes) });
      const size = movement === 'rotate' ? [.4, .2, 3] : [.2, .4, 3];
      close(centre(saved.meshes, added.expressId, size), after);
      close(centre(current.models.get(MODEL)!.geometryResult!.meshes, globalId, size), after);
      assert.ok(current.pendingMeshEdits?.ids.has(globalId), 'real replacement reaches the renderer drain');
      assert.equal(current.pendingMeshTranslations, null, 'canonical replacement is not also translated');
      assert.equal(current.pendingMeshRotations, null, 'canonical replacement is not also rotated');
      assert.equal(current.models.get('peer')?.geometryResult, peerGeometry, 'peer geometry is untouched');
      act(() => useViewerStore.getState().undo(MODEL));
      await advance(30);
      close(centre(useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes, globalId), before);
      act(() => useViewerStore.getState().redo(MODEL));
      await advance(30);
      close(centre(useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes, globalId), after);
      if (count === 2 && mm && movement === 'translate') {
        // Two different grids moved by the same gizmo batch must both be
        // rebuilt on its one Undo/Redo. The second owner is overlay-created.
        const second = addGridIn(useViewerStore, MODEL, STOREY, {
          Position: [0, 0, 0], ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }),
        });
        assert.ok('expressId' in second);
        const column = addGridColumnIn(useViewerStore, MODEL, STOREY, {
          Position: [6, 4, .5], Width: .4, Depth: .2, Height: 3,
        }, { GridId: second.expressId, IntersectingAxes: [second.build.uAxisIds[1], second.build.vAxisIds[1]] });
        assert.ok('expressId' in column);
        await act(async () => { assert.equal((await requestRemesh(useViewerStore.getState, MODEL, [column.expressId], 'created')).status, 'applied'); });
        const secondId = toGlobalIdFromModels(useViewerStore.getState().models, MODEL, column.expressId);
        const secondBefore = [origin[0] - 4, origin[1] + 6, 2];
        close(centre(useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes, secondId), secondBefore);
        act(() => {
          assert.ok(useViewerStore.getState().translateEntity(MODEL, made.expressId, [1, 0, 0], 'shared-grid-drag').ok);
          assert.ok(useViewerStore.getState().translateEntity(MODEL, second.expressId, [2, 0, 0], 'shared-grid-drag').ok);
        });
        await advance(30);
        const firstMoved = [after[0], after[1] + 1, 2], secondMoved = [secondBefore[0], secondBefore[1] + 2, 2];
        const live = () => useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes;
        close(centre(live(), globalId), firstMoved); close(centre(live(), secondId), secondMoved);
        act(() => useViewerStore.getState().undo(MODEL));
        await advance(30);
        close(centre(live(), globalId), after); close(centre(live(), secondId), secondBefore);
        act(() => useViewerStore.getState().redo(MODEL));
        await advance(30);
        close(centre(live(), globalId), firstMoved); close(centre(live(), secondId), secondMoved);
      }
    } finally { setRemeshClientFactory(null); api.free(); }
  });
});
