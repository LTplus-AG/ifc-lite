/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { blur, cleanup, render, type } from '@/test/render.js';
import { StepExporter } from '@ifc-lite/export';
import * as create from '@ifc-lite/create';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { toGlobalIdFromModels } from '@/store/globalId';
import { addStairIn } from '@/store/slices/mutation-stair-railing';
import { meshStairs, stairMeshBounds, stairWasmAvailable } from '../../../../../../packages/create/src/in-store/__test__/stair-mesh.oracle.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin.js';
import { commandPointerDown, commandPointerMove } from '@/lib/commands/modeling/runtime.js';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction.js';
import { ModelInspectorPanel } from './ModelInspectorPanel.js';

// Keep revert-oracle collection intact and require a real canonical read.
function dimensions(...args: Parameters<typeof create.readStairDimensions>) {
  const read = create.readStairDimensions?.(...args);
  assert.ok(read, 'the selected flight has readable canonical dimensions');
  return read;
}

afterEach(() => { cleanup(); useViewerStore.getState().exitModelWorkspace(); });

for (const unit of ['metre', 'millimetre'] as const) it(`the flight selected by stair.place edits dimensions with one physical Undo in ${unit} (#6232)`, { skip: !stairWasmAvailable && 'Build WASM to run this physical inspector proof' }, async () => {
  await seedModelingSession({ unit, storeyOffset: [3, 3] });
  const restore = setRequestRemesh(() => {});
  try {
    const s = () => useViewerStore.getState();
    s().startCommand('stair.place');
    for (const local of [[1, 1], [6, 1]] as [number, number][]) act(() => {
      const snap = { local, winner: null, guides: [], locked: false };
      commandPointerMove(snap);
      commandPointerDown(snap);
    });
    const flight = s().mutationViews.get(MODEL_ID)!.getNewEntities().find(e => e.type.toUpperCase() === 'IFCSTAIRFLIGHT');
    assert.ok(flight, 'the actual command authored a flight');
    const selected = s().resolveGlobalIdFromModels(s().selectedEntityId!);
    assert.equal(selected?.expressId, flight.expressId, 'test the actual command selection');
    const root = render(<ModelInspectorPanel />);
    const field = root.querySelector<HTMLInputElement>('input[aria-label="Width in metres"]');
    assert.ok(field, 'a selected authored stair flight offers its Width');
    assert.equal(field.readOnly, false);
    assert.equal(field.value, '1.00');
    const store = s().models.get(MODEL_ID)!.ifcDataStore!, view = s().mutationViews.get(MODEL_ID)!;
    const exportModel = () => new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);
    const before = await meshStairs(exportModel());
    assert.ok(before.get(flight.expressId)?.length, 'the selected stair has real triangles');
    const original = stairMeshBounds(before.get(flight.expressId)!);
    const depth = s().undoStacks.get(MODEL_ID)?.length ?? 0;
    for (const [label, param, value, deltas] of [
      ['Width', 'Width', 1.4, [0, 0.4, 0]],
      ['Riser height', 'RiserHeight', 0.2, [0, 0, 0.4]],
      ['Tread length', 'TreadLength', 0.35, [0.95, 0, 0]],
      ['Waist thickness', 'WaistThickness', 0.2, [0, 0, 0]],
    ] as const) {
      const input = root.querySelector<HTMLInputElement>(`input[aria-label="${label} in metres"]`);
      assert.ok(input, `${label} is present`);
      type(input, String(value)); blur(input);
      assert.ok(Math.abs(dimensions(store, flight.expressId, view)[param]! - value) < 1e-8);
      const after = await meshStairs(exportModel());
      const changed = stairMeshBounds(after.get(flight.expressId)!);
      assert.notDeepEqual(after.get(flight.expressId), before.get(flight.expressId), 'the physical triangles changed');
      for (const axis of [0, 1, 2]) {
        assert.ok(Math.abs(changed.min[axis] - original.min[axis]) < 1e-5, `${label}: the foot remains fixed`);
        assert.ok(Math.abs(changed.max[axis] - original.max[axis] - deltas[axis]) < 1e-5, `${label}: only the intended extent changes`);
      }
      act(() => s().undo(MODEL_ID));
      assert.deepEqual((await meshStairs(exportModel())).get(flight.expressId), before.get(flight.expressId));
      assert.equal(s().undoStacks.get(MODEL_ID)?.length ?? 0, depth, `${label}: one Undo restores the entire flight body`);
    }
  } finally { restore(); }
});

for (const modelCount of [1, 2]) it(`a selected stair resolves its overlay owner with ${modelCount} model(s) (#6232)`, async () => {
  await seedModelingSession();
  const s = () => useViewerStore.getState();
  const params = { Position: [1, 1, 0] as [number, number, number], NumberOfRisers: 10, RiserHeight: 0.2, TreadLength: 0.3, Width: 1.2 };
  const created = addStairIn(useViewerStore, MODEL_ID, STOREY, params);
  assert.ok('flightId' in created && created.flightId !== undefined);
  const flight = created.flightId;
  assert.equal(s().enterModelWorkspace(), true);
  const owner = { ...s().models.get(MODEL_ID)!, idOffset: 1_000_000, maxExpressId: 139 };
  const models = new Map([[MODEL_ID, owner]]);
  const ownerView = s().mutationViews.get(MODEL_ID)!;
  let decoyView: MutablePropertyView | undefined;
  if (modelCount === 2) {
    const data = await owner.ifcDataStore!.source.withMaterializedAsync(bytes => new IfcParser().parseColumnar(Uint8Array.from(bytes).buffer, { disableWorkerScan: true }));
    models.set('decoy', { ...owner, id: 'decoy', name: 'decoy', idOffset: 0, ifcDataStore: data });
    decoyView = new MutablePropertyView(data.properties ?? null, 'decoy');
    useViewerStore.setState({ models, mutationViews: new Map([[MODEL_ID, ownerView], ['decoy', decoyView]]) });
    const decoy = addStairIn(useViewerStore, 'decoy', STOREY, params);
    assert.ok('flightId' in decoy);
    assert.equal(decoy.flightId, flight, 'independently authored flights collide in local overlay ids');
    useViewerStore.setState({ activeModelId: 'decoy', ifcDataStore: data, session: { ...s().session!, modelId: 'decoy' } });
  }
  useViewerStore.setState({ models });
  s().setSelectedEntityId(toGlobalIdFromModels(models, MODEL_ID, flight));
  const root = render(<ModelInspectorPanel />);
  const field = root.querySelector<HTMLInputElement>('input[aria-label="Width in metres"]');
  assert.ok(field);
  const ownerDepth = s().undoStacks.get(MODEL_ID)?.length ?? 0, decoyDepth = s().undoStacks.get('decoy')?.length ?? 0;
  const decoySnapshot = decoyView ? JSON.stringify({ entities: decoyView.getNewEntities(), records: decoyView.getMutations() }) : null;
  const remesh: Array<{ modelId: string }> = [];
  const restore = setRequestRemesh((_get, request) => remesh.push(request));
  try {
    type(field, '1.4'); blur(field);
    assert.ok(Math.abs(dimensions(owner.ifcDataStore!, flight, ownerView).Width - 1.4) < 1e-8);
    assert.deepEqual(remesh.map(r => r.modelId), [MODEL_ID]);
    assert.equal(s().undoStacks.get('decoy')?.length ?? 0, decoyDepth);
    if (decoyView) {
      assert.equal(JSON.stringify({ entities: decoyView.getNewEntities(), records: decoyView.getMutations() }), decoySnapshot);
      assert.ok(Math.abs(dimensions(models.get('decoy')!.ifcDataStore!, flight, decoyView).Width - 1.2) < 1e-8);
    }
    act(() => s().undo(MODEL_ID));
    assert.equal(s().undoStacks.get(MODEL_ID)?.length ?? 0, ownerDepth);
    assert.ok(Math.abs(dimensions(owner.ifcDataStore!, flight, ownerView).Width - 1.2) < 1e-8);
  } finally { restore(); }
});
