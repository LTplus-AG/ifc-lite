/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: an immutable source Location or LocalPlacement can have consumers
 * outside the selected wall. Split and multisplit must detach their edits. */
import '@/test/setup-dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { readHostedFill, readWallJoinTarget } from '@ifc-lite/create';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { AnchorEntityReader } from '../../../../../../../packages/create/src/in-store/resolve-anchor.js';
import { insideMesh, meshWalls } from '../../../../../../../packages/create/src/in-store/wall-join-mesh.oracle.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { cleanup } from '@/test/render.js';
import type { SnapResult } from '@/lib/snap/types';
import '../builtin.js';
import { commandPointerDown, commandPointerMove, getCommandRuntime } from '../runtime.js';
import { setRequestRemesh } from '../transaction.js';
import type { SplitGesture } from './element-split.js';
import type { MultiSplitGesture } from './multi-split.js';

const wasmPath = fileURLToPath(new URL('../../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const state = () => useViewerStore.getState();
const live = () => ({ store: state().models.get(MODEL_ID)!.ifcDataStore!, view: state().mutationViews.get(MODEL_ID)!, editor: state().storeEditors.get(MODEL_ID)! });
const refId = (value: unknown) => typeof value === 'number' ? value : Number(String(value).slice(1));
function built(result: { expressId: number } | { error: string }): number {
  assert.ok('expressId' in result, 'error' in result ? result.error : '');
  return result.expressId;
}
function exportModel(): string {
  const { store, view } = live();
  return new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);
}

async function sourceSharing(unit: 'metre' | 'millimetre') {
  await seedModelingSession({ unit, storeyOffset: [3, 3] });
  const wall = (y: number) => built(state().addWall(MODEL_ID, STOREY,
    { Start: [0, y, 0], End: [4, y, 0], Thickness: 0.2, Height: 2.5 }));
  const host = wall(0), otherHost = wall(2), secondSelected = wall(4);
  const window = (wallId: number, Offset: number) => built(state().addHostedFill(MODEL_ID, wallId,
    { kind: 'window', params: { Offset, Sill: 0.9, Width: 0.8, Height: 1.2 } }));
  const far = window(host, 3.2), near = window(host, 1), other = window(otherHost, 3.2);
  const { store, view, editor } = live(), reader = new AnchorEntityReader(store, view);
  const filling = readHostedFill(store, far, view)!;
  const sharedPoint = filling.locationPointId;
  const sharedPlacement = refId(reader.entity(filling.openingId)!.attributes[5]);
  const otherOpening = readHostedFill(store, other, view)!.openingId;
  const otherPlacement = reader.entity(refId(reader.entity(otherOpening)!.attributes[5]))!;
  editor.setPositionalAttribute(refId(otherPlacement.attributes[1]), 0, `#${sharedPoint}`);
  // An independent product consumes the exact same LocalPlacement. Rehosting
  // the opening must leave that source placement's parent and axis unchanged.
  const witness = editor.addEntity('IfcBuildingElementProxy', ['2ZQ$n5SLP5MBLyL442paFx', null,
    'Shared placement witness', null, null, `#${sharedPlacement}`, null, null, '.NOTDEFINED.']).expressId;
  const bytes = new TextEncoder().encode(exportModel());
  const source = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const model = state().models.get(MODEL_ID)!;
  useViewerStore.setState({ models: new Map([[MODEL_ID, { ...model, ifcDataStore: source }]]),
    mutationViews: new Map([[MODEL_ID, new MutablePropertyView(source.properties || null, MODEL_ID)]]),
    storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map() });
  return { host, otherHost, secondSelected, far, near, other, sharedPoint, sharedPlacement, witness };
}

function worldX(windowId: number): number {
  const { store, view } = live(), filling = readHostedFill(store, windowId, view)!;
  const host = readWallJoinTarget(store, view, filling.hostId, getModelLengthUnitScale(store))!;
  return host.origin[0] + filling.offset;
}
const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false });
function split(mode: 'single' | 'multi', host: number, second: number) {
  const models = state().models;
  state().setSelectedEntityIds((mode === 'single' ? [host] : [host, second])
    .map(id => toGlobalIdFromModels(models, MODEL_ID, id)));
  if (mode === 'single') {
    state().setSelectedEntityId(toGlobalIdFromModels(models, MODEL_ID, host));
    state().startCommand('element.split');
    const plane = (getCommandRuntime().gesture as SplitGesture).plane;
    assert.ok(plane);
    const snap: SnapResult = { ...at(2, 0), render: plane.localToRender([2, 0.05, 1.2]) };
    act(() => { commandPointerMove(snap); commandPointerDown(snap); });
  } else {
    state().startCommand('split.multi');
    act(() => { commandPointerMove(at(2, -1)); commandPointerDown(at(2, -1)); commandPointerMove(at(2, 5)); });
    assert.equal((getCommandRuntime().gesture as MultiSplitGesture).plan.splits.length, 2);
    act(() => { commandPointerDown(at(2, 5)); });
  }
}
afterEach(() => { cleanup(); state().exitModelWorkspace(); });

for (const mode of ['single', 'multi'] as const) for (const unit of ['metre', 'millimetre'] as const) {
  describe(`${mode} wall split with shared source placements in ${unit} (#6232)`, () => {
    it('preserves unselected cuts, immutable source placements, both piece voids and one-step Undo', async t => {
      if (!existsSync(wasmPath)) { t.skip('Build WASM for the physical shared-placement split oracle'); return; }
      const s = await sourceSharing(unit), originalX = [worldX(s.far), worldX(s.near), worldX(s.other)];
      const { store, view } = live(), reader = new AnchorEntityReader(store, view);
      assert.equal(readHostedFill(store, s.other, view)!.locationPointId, s.sharedPoint);
      assert.equal(refId(reader.entity(s.witness)!.attributes[5]), s.sharedPlacement);
      const originalPoint = reader.entity(s.sharedPoint), originalPlacement = reader.entity(s.sharedPlacement);
      initSync({ module: readFileSync(wasmPath) });
      const api = new IfcAPI(), restore = setRequestRemesh(() => {});
      try {
        const before = meshWalls(api, exportModel()), otherMesh = before.get(s.otherHost);
        assert.ok(before.get(s.host)?.length && otherMesh?.length, 'both original hosts have real voided meshes');
        split(mode, s.host, s.secondSelected);
        const afterFill = readHostedFill(store, s.far, view)!;
        assert.notEqual(afterFill.hostId, s.host, 'the far cut belongs to the newly created right piece');
        assert.ok(Math.abs(worldX(s.other) - originalX[2]) < 1e-6, 'the unselected wall opening must not follow a shared source point');
        assert.deepEqual(reader.entity(s.sharedPoint), originalPoint, 'shared source point stays immutable');
        assert.deepEqual(reader.entity(s.sharedPlacement), originalPlacement, 'shared source LocalPlacement stays immutable');
        assert.deepEqual([worldX(s.far), worldX(s.near)], originalX.slice(0, 2));
        const after = meshWalls(api, exportModel());
        assert.deepEqual(after.get(s.otherHost), otherMesh, 'the other host retains its complete physical mesh');
        const left = after.get(s.host)!, right = after.get(afterFill.hostId)!;
        assert.ok(left?.length && right?.length);
        assert.equal(insideMesh(left, [4, 1.5, -3]), false, 'the near opening remains cut in the left piece');
        assert.equal(insideMesh(right, [6.2, 1.5, -3]), false, 'the far opening remains cut in the right piece');
        assert.equal(insideMesh(left, [3.2, 1.5, -3]), true, 'the left body still has solid material');
        assert.equal(insideMesh(right, [5.2, 1.5, -3]), true, 'the right body still has solid material');
        const batches = new Set((state().undoStacks.get(MODEL_ID) ?? []).map(m => state().mutationBatchTags.get(m.id) ?? m.id));
        assert.equal(batches.size, 1);
        state().undo(MODEL_ID);
        assert.deepEqual([worldX(s.far), worldX(s.near), worldX(s.other)], originalX);
        assert.deepEqual(meshWalls(api, exportModel()).get(s.host), before.get(s.host));
        assert.deepEqual(meshWalls(api, exportModel()).get(s.otherHost), otherMesh);
        assert.equal(readHostedFill(store, s.far, view)!.hostId, s.host);
      } finally { restore(); api.free(); }
    });
  });
}
