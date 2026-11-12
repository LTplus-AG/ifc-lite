/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, mock } from 'node:test';
import { EntityExtractor } from '@ifc-lite/parser';
import { rectangularGridAxes } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { modelEditTarget, recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { addGridIn } from '@/store/slices/mutation-curtain-grid';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { storeyAttachmentDisplay } from '@/lib/actions/storey-attachment-display';
import { storeyGridAxes } from '@/lib/snap/sources/ifc-grid-store';
import { storeyWallAxes } from '@/lib/snap/sources/semantic-walls';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';

let restore = () => {};
let column: number;
beforeEach(async () => {
  await seedModelingSession();
  restore = setRequestRemesh(() => {});
  const made = useViewerStore.getState().addColumn(MODEL_ID, STOREY, { Position: [1, 1, 0], Width: 0.3, Depth: 0.3, Height: 3 });
  assert.ok('expressId' in made);
  column = made.expressId;
  const grid = addGridIn(useViewerStore, MODEL_ID, STOREY, { Position: [0, 0, 0], ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }) });
  assert.ok('expressId' in grid);
});
afterEach(() => { restore(); mock.restoreAll(); });
const target = () => modelEditTarget(useViewerStore.getState(), MODEL_ID)!;
const grids = () => { const t = target(); return storeyGridAxes(t.dataStore, t.view, STOREY); };
const walls = () => { const t = target(); return storeyWallAxes(t.dataStore, t.view, STOREY); };
const levels = () => modelStoreys(useViewerStore.getState(), MODEL_ID);
const attachment = () => storeyAttachmentDisplay(useViewerStore.getState(), MODEL_ID, column, '2hQBAVPOr5VxhS3Jl0O47i');

for (const [name, derive] of [['grids', grids], ['wall axes', walls], ['storeys', levels], ['storey attachment inventory', attachment]] as const) {
  it(`#9296 column Move and Undo do not reparse ${name}`, () => {
    const spy = mock.method(EntityExtractor.prototype, 'extractEntity');
    const before = derive();
    spy.mock.resetCalls();
    assert.ok(useViewerStore.getState().translateEntity(MODEL_ID, column, [0.5, 0, 0]).ok);
    spy.mock.resetCalls(); // count the actual derivation, not the Move planner
    assert.deepEqual(derive(), before);
    assert.equal(spy.mock.callCount(), 0, 'unrelated edit reuses derived IFC state');
    useViewerStore.getState().undo(MODEL_ID);
    spy.mock.resetCalls();
    assert.deepEqual(derive(), before);
    assert.equal(spy.mock.callCount(), 0, 'unrelated undo reuses derived IFC state');
  });
}

it('#9296 a grid axis edit, undo and redo update the cached output', () => {
  const before = grids();
  const axis = before[0].axisId;
  recordModellingEdit(useViewerStore, MODEL_ID, (_m, draft) => draft.setPositionalAttribute(axis, 0, 'Changed'));
  assert.equal(grids().find(x => x.axisId === axis)?.AxisTag, 'Changed');
  useViewerStore.getState().undo(MODEL_ID);
  assert.deepEqual(grids(), before);
  useViewerStore.getState().redo(MODEL_ID);
  assert.equal(grids().find(x => x.axisId === axis)?.AxisTag, 'Changed');
});

it('#9296 storey edits and their undo update names and attachment display', () => {
  const before = levels();
  const oldDisplay = attachment();
  recordModellingEdit(useViewerStore, MODEL_ID, (_m, draft) => draft.setPositionalAttribute(50, 2, 'Renamed'));
  assert.equal(levels().find(x => x.expressId === 50)?.name, 'Renamed');
  assert.notDeepEqual(attachment(), oldDisplay);
  useViewerStore.getState().undo(MODEL_ID);
  assert.deepEqual(levels(), before);
  assert.deepEqual(attachment(), oldDisplay);
});

it('#9296 wall placement edits and undo update axes used by workplane bounds and joins', () => {
  const before = walls();
  recordModellingEdit(useViewerStore, MODEL_ID, (_m, draft) => draft.setPositionalAttribute(133, 0, [2, 5, 0]));
  assert.notDeepEqual(walls(), before);
  useViewerStore.getState().undo(MODEL_ID);
  assert.deepEqual(walls(), before);
});
