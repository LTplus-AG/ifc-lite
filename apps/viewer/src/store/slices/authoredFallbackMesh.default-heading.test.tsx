/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6593: the implicit column heading is storey-local +X, just like the IFC writer. */
import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import { render, cleanup, advance } from '@/test/render';
import { installScriptedMesher } from '@/test/scripted-mesher';
import { toGlobalIdFromModels } from '@/store/globalId';
import { PlanView } from '@/components/viewer/plan/PlanView';
import { emptyPlacementState } from '@/lib/model-placement/state';

const MODEL = 'bonsai', STOREY = 42;
let mesher: ReturnType<typeof installScriptedMesher> | null = null;
afterEach(() => { cleanup(); mesher?.restore(); mesher = null; useViewerStore.getState().exitModelWorkspace(); });

for (const count of [1, 2] as const) for (const millimetres of [false, true]) {
  for (const decline of ['noFrame', 'empty'] as const) for (const explicit of [false, true]) {
    it(`#6593 ${count} Bonsai models / ${millimetres ? 'mm' : 'm'} / ${decline}: ${explicit ? 'explicit' : 'default'} heading follows the rotated storey`, async () => {
      await seedModelingSession();
      const k = millimetres ? 1000 : 1;
      let source = readFileSync(new URL('../../../public/samples/hello-wall.ifc', import.meta.url), 'utf8')
        .replace('#61=IFCCARTESIANPOINT((0.,0.,0.));', `#61=IFCCARTESIANPOINT((${k}.,${2 * k}.,0.));`)
        .replace('#63=IFCDIRECTION((1.,0.,0.));', '#63=IFCDIRECTION((0.,1.,0.));');
      if (millimetres) source = source.replace('#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);');
      const state = useViewerStore.getState(), geometry = { ...state.geometryResult!, coordinateInfo: {
        ...state.geometryResult!.coordinateInfo!,
        wasmRtcFrame: decline === 'noFrame' ? undefined : { x: 0, y: 0, z: 0, needsShift: false },
      } };
      const models = new Map(state.models); models.clear();
      const views = new Map<string, MutablePropertyView>();
      for (const [i, id] of [MODEL, 'peer'].slice(0, count).entries()) {
        const parsed = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer, { disableWorkerScan: true });
        assert.equal(parsed.entities.getTypeName(STOREY), 'IfcBuildingStorey');
        models.set(id, { ...fixtureModel(id, { idOffset: count === 1 ? 0 : (i + 1) * 1_000_000 }), ifcDataStore: parsed, geometryResult: geometry });
        views.set(id, new MutablePropertyView(parsed.properties ?? null, id));
      }
      useViewerStore.setState({ models, activeModelId: MODEL, mutationViews: views, geometryResult: geometry,
        storeEditors: new Map(), modelPlacement: emptyPlacementState(), hostHiddenIfcTypes: null,
        pendingMeshEdits: null, hiddenEntities: new Set(), selectedEntityId: null, selectedEntityIds: new Set() });
      mesher = installScriptedMesher(() => []); // Only the native refusal is scripted; the fallback box is real.
      assert.ok(useViewerStore.getState().enterModelWorkspace({ modelId: MODEL, storeyId: STOREY }));
      const ui = render(<PlanView layout="split" />);
      assert.ok(ui.querySelector('svg'), 'actual plan is mounted for the real storey');
      const peer = models.get('peer')?.geometryResult;
      let made!: ReturnType<ReturnType<typeof useViewerStore.getState>['addColumn']>;
      act(() => {
        made = useViewerStore.getState().addColumn(MODEL, STOREY, {
          Position: [96, 206, .5], Width: .4, Depth: .2, Height: 3,
          ...(explicit ? { RefDirection: [1, 0, 0] as [number, number, number] } : {}),
        });
      });
      assert.ok('expressId' in made, 'error' in made ? made.error : 'no column id');
      const id = made.expressId, globalId = toGlobalIdFromModels(models, MODEL, id);
      const meshes = () => useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes.filter(m => m.expressId === globalId);
      const physicalBounds = () => {
        assert.equal(meshes().length, 1, 'native refusal still leaves a visible column');
        const mesh = meshes()[0], min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        assert.equal(mesh.positions.length, 72, 'the actual fallback box has 24 vertices');
        for (let i = 0; i < mesh.positions.length; i++) {
          const axis = i % 3, value = mesh.positions[i] + (mesh.origin?.[axis] ?? 0);
          min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
        }
        return { centre: min.map((v, i) => +((v + max[i]) / 2).toFixed(4)), size: max.map((v, i) => +(v - min[i]).toFixed(4)) };
      };
      await advance(30);
      // Source storey [1,2]m and +90° maps [96,206,.5] to IFC [-205,98,.5].
      // Y-up puts the 3m extrusion centre at [-205,2,-98]; Width is model Y.
      assert.deepEqual(physicalBounds(), { centre: [-205, 2, -98], size: [.2, 3, .4] });
      assert.equal(useViewerStore.getState().models.get('peer')?.geometryResult, peer, 'peer geometry is untouched');
      assert.equal(mesher.requests.length, decline === 'noFrame' ? 0 : 1);
      act(() => useViewerStore.getState().undo(MODEL));
      assert.equal(meshes().length, 0, 'one actual Undo removes the mesh');
      assert.ok(useViewerStore.getState().mutationViews.get(MODEL)!.isDeleted(id));
      act(() => useViewerStore.getState().redo(MODEL));
      await advance(30);
      assert.deepEqual(physicalBounds(), { centre: [-205, 2, -98], size: [.2, 3, .4] }, 'Redo restores the correctly oriented section');
    });
  }
}
