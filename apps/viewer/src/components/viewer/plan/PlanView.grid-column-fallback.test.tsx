/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 / #6592: a bound column must use the same visible authored fallback
 * contract as an ordinary column when native remeshing cannot supply a mesh. */
import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { fixture, MODEL, STOREY } from '@/test/bonsai-plan-grid-fixture';
import { cleanup, advance } from '@/test/render';
import { installScriptedMesher } from '@/test/scripted-mesher';
import { addGridColumnIn } from '@/store/slices/mutation-grid-column';
import { toGlobalIdFromModels } from '@/store/globalId';

let mesher: ReturnType<typeof installScriptedMesher> | null = null;
afterEach(() => { cleanup(); mesher?.restore(); mesher = null; useViewerStore.getState().exitModelWorkspace(); });

for (const count of [1, 2] as const) for (const decline of ['noFrame', 'empty'] as const) {
  describe(`#6592 authored column fallback: ${count} Bonsai models / ${decline}`, () => {
    for (const bound of [false, true]) it(`${bound ? 'grid-bound' : 'ordinary control'} column is drawn in its real frame, revealed and undoable`, async () => {
      const { ui, made } = await fixture(count, { millimetres: true, rotatedStorey: true, reload: true });
      assert.equal(ui.querySelectorAll('[data-plan-layer="design-grids"] line').length, 4);
      // The worker's declared empty result exercises the real parameter-built
      // fallback, whose independent physical bounds are asserted below.
      mesher = installScriptedMesher(() => []);
      const state = useViewerStore.getState(), model = state.models.get(MODEL)!;
      const geometry = { ...model.geometryResult!, meshes: [], coordinateInfo: {
        ...model.geometryResult!.coordinateInfo!,
        originShift: { x: 0, y: 0, z: 0 },
        wasmRtcFrame: decline === 'noFrame' ? undefined : { x: 0, y: 0, z: 0, needsShift: false },
      } };
      const models = new Map(state.models);
      models.set(MODEL, { ...model, geometryResult: geometry });
      act(() => useViewerStore.setState({ models, geometryResult: geometry, pendingMeshEdits: null }));
      const peer = models.get('peer')?.geometryResult;
      act(() => useViewerStore.getState().setTypeViewMode('types'));
      const params = { Position: [96, 206, .5] as [number, number, number], Width: .4, Depth: .2, Height: 3, RefDirection: [1, 0, 0] as [number, number, number] };
      let madeColumn!: ReturnType<typeof addGridColumnIn>;
      act(() => {
        madeColumn = bound ? addGridColumnIn(useViewerStore, MODEL, STOREY, params, {
          GridId: made.expressId, IntersectingAxes: [made.build.uAxisIds[1], made.build.vAxisIds[1]],
        }) : useViewerStore.getState().addColumn(MODEL, STOREY, params);
      });
      assert.ok('expressId' in madeColumn, JSON.stringify(madeColumn));
      const id = madeColumn.expressId, globalId = toGlobalIdFromModels(models, MODEL, id);
      const meshes = () => useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes.filter(m => m.expressId === globalId);
      await advance(30);
      assert.equal(meshes().length, 1, 'the authored column has a mesh despite the native refusal/empty result');
      const mesh = meshes()[0];
      assert.equal(mesh.positions.length, 72, 'the real fallback builds the section box');
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < mesh.positions.length; i++) {
        const axis = i % 3, value = mesh.positions[i] + (mesh.origin?.[axis] ?? 0);
        min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
      }
      // Actual source storey is [1,2] metres, rotated90: [96,206,.5]
      // becomes IFC [-205,98,.5], hence Y-up centre [-205,2,-98].
      const centre = min.map((v, i) => (v + max[i]) / 2);
      const size = max.map((v, i) => v - min[i]);
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(Math.abs(centre[axis] - [-205, 2, -98][axis]) < 1e-4);
        assert.ok(Math.abs(size[axis] - [.2, 3, .4][axis]) < 1e-4);
      }
      assert.equal(useViewerStore.getState().typeViewMode, 'model', 'new occurrence geometry is revealed from Types view');
      assert.equal(useViewerStore.getState().models.get('peer')?.geometryResult, peer);
      if (decline === 'noFrame') assert.equal(mesher.requests.length, 0, 'no unresolved frame is sent to a worker');
      act(() => useViewerStore.getState().undo(MODEL));
      assert.equal(meshes().length, 0, 'one actual Undo removes the column and its visible fallback');
      assert.ok(useViewerStore.getState().mutationViews.get(MODEL)!.isDeleted(id));
      act(() => useViewerStore.getState().redo(MODEL));
      await advance(30);
      assert.equal(meshes().length, 1, 'one Redo restores the visible authored mesh');
    });
  });
}
