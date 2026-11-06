/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9013: the viewer's one storey write path. Every op is one undo step, a
 * new storey is immediately usable (listed, drawable, in the tree), refusals
 * never reach the undo stack, and walls drawn "to the storey above" record
 * the attachment that later edits follow.
 */

import '@/test/setup-dom.js';
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readTopAttachment, readStoreyInventory } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { setRequestRemesh, type RemeshRequest } from '@/lib/commands/modeling/transaction';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { effectiveSpatialProject } from '@/components/viewer/hierarchy/effectiveStoreyNodes';
import { addStoreyNextTo, deleteStorey } from '@/lib/storeys/storey-actions';
import { keepStoreyPreview, previewStoreyLevel, revertStoreyPreview } from '@/lib/storeys/storey-preview';
import '@/lib/commands/modeling/builtin.js';
import { commandPointerDown, commandPointerMove } from '@/lib/commands/modeling/runtime';
import { modelEditTarget } from './mutation-modelling-records.js';
import { commitStoreyOp } from './mutation-storey.js';

const fallback = (index: number) => `Level ${index}`;
let remeshed: RemeshRequest[] = [];
let restore: () => void = () => {};

beforeEach(async () => {
  await seedModelingSession();
  remeshed = [];
  restore = setRequestRemesh((_get, request) => { remeshed.push(request); });
  useViewerStore.getState().enterModelWorkspace({ modelId: MODEL_ID, storeyId: STOREY });
});
afterEach(() => { restore(); useViewerStore.getState().exitModelWorkspace(); });

const storeys = () => modelStoreys(useViewerStore.getState(), MODEL_ID).map((s) => [s.name, s.elevation]);
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const batches = () => {
  const s = useViewerStore.getState();
  return new Set((s.undoStacks.get(MODEL_ID) ?? []).map((m) => s.mutationBatchTags.get(m.id))).size;
};

describe('storey ops in the viewer (#9013)', () => {
  it('adds a storey above the top one, makes it the drawing storey, and lists it in the tree', () => {
    const outcome = addStoreyNextTo(useViewerStore, MODEL_ID, UPPER_STOREY, 'above', fallback);
    assert.ok(outcome.ok);
    assert.ok(outcome.storeyId !== null);
    assert.equal(useViewerStore.getState().session?.storeyId, outcome.storeyId, 'the new storey is the one being drawn on');
    assert.equal(storeys().at(-1)?.[1], 6, 'spacing repeats the storey below');
    assert.equal(batches(), 1, 'one undo step');
    const s = useViewerStore.getState();
    const project = effectiveSpatialProject(s.models.get(MODEL_ID)!.ifcDataStore!, s.mutationViews.get(MODEL_ID));
    const found: number[] = [];
    const walk = (node: NonNullable<typeof project>) => { found.push(node.expressId); node.children.forEach(walk); };
    walk(project!);
    assert.ok(found.includes(outcome.storeyId!), 'the hierarchy lists the new storey');

    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(storeys().length, 2, 'undo removes it again');
  });

  it('draws a wall on a new storey: the wall is contained there', () => {
    const outcome = addStoreyNextTo(useViewerStore, MODEL_ID, UPPER_STOREY, 'above', fallback);
    assert.ok(outcome.ok && outcome.storeyId !== null);
    const wall = useViewerStore.getState().addWall(MODEL_ID, outcome.storeyId!, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok(!('error' in wall));
    const target = modelEditTarget(useViewerStore.getState(), MODEL_ID)!;
    const inventory = readStoreyInventory(target.dataStore, target.view);
    assert.equal(inventory.storeys.find((s) => s.expressId === outcome.storeyId)?.elevation, 6);
  });

  it('re-levels as one undo step and re-meshes what moved', () => {
    const wall = useViewerStore.getState().addWall(MODEL_ID, UPPER_STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok(!('error' in wall));
    const depth = undoDepth();
    remeshed = [];
    const outcome = commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'level', edit: { kind: 'floorHeight', storeyId: STOREY, Height: 3.5 } });
    assert.ok(outcome.ok);
    assert.deepEqual(storeys().map(([, e]) => e), [0, 3.5]);
    assert.ok(remeshed.some((r) => r.expressIds.includes(wall.expressId)), 'the wall on the moved storey is re-meshed');
    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), depth);
    assert.deepEqual(storeys().map(([, e]) => e), [0, 3]);
    useViewerStore.getState().redo(MODEL_ID);
    assert.deepEqual(storeys().map(([, e]) => e), [0, 3.5]);
  });

  it('refuses an invalid edit with the reason and leaves history untouched', () => {
    const depth = undoDepth();
    const outcome = commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'level', edit: { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: -1 } });
    assert.ok(!outcome.ok);
    assert.equal(outcome.refusals[0]?.code, 'crossing');
    assert.equal(undoDepth(), depth);
    assert.deepEqual(storeys().map(([, e]) => e), [0, 3]);
  });

  it('previews for real, reverts on cancel with the redo history restored, and keeps on Enter as one step', () => {
    const depth = undoDepth();
    const preview = previewStoreyLevel(useViewerStore, MODEL_ID, { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.4 });
    assert.ok(preview.applied);
    assert.deepEqual(storeys().map(([, e]) => e), [0, 3.4], 'the model shows the edit while it is typed');
    revertStoreyPreview(useViewerStore);
    assert.deepEqual(storeys().map(([, e]) => e), [0, 3]);
    assert.equal(undoDepth(), depth);
    assert.equal(useViewerStore.getState().redoStacks.get(MODEL_ID)?.length ?? 0, 0, 'cancelling leaves nothing to redo');

    previewStoreyLevel(useViewerStore, MODEL_ID, { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.2 });
    previewStoreyLevel(useViewerStore, MODEL_ID, { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.6 });
    assert.ok(keepStoreyPreview());
    assert.deepEqual(storeys().map(([, e]) => e), [0, 3.6]);
    assert.equal(batches(), 1, 'typing two values then Enter is one undo step');
  });

  it('deleting the drawing storey moves the session to a live one first', () => {
    useViewerStore.getState().setSessionStorey(UPPER_STOREY);
    const outcome = deleteStorey(useViewerStore, MODEL_ID, UPPER_STOREY, { kind: 'empty' });
    assert.ok(outcome.ok);
    assert.equal(useViewerStore.getState().session?.storeyId, STOREY);
    assert.deepEqual(storeys().map(([name]) => name).length, 1);
  });
});

describe('walls drawn to the storey above (#9013 requirement 4)', () => {
  /** Two clicks place one wall through the real Wall tool. */
  const draw = (y: number) => {
    useViewerStore.getState().startCommand('wall.place');
    const at = (x: number) => ({ local: [x, y] as [number, number], winner: null, guides: [], locked: false, metresPerPixel: 0.02 });
    commandPointerMove(at(0)); commandPointerDown(at(0));
    commandPointerMove(at(4)); commandPointerDown(at(4));
    useViewerStore.getState().startCommand('wall.place'); // a fresh chain for the next wall
    const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
    return view.getNewEntities().filter((e) => e.type === 'IfcWall').at(-1)!.expressId;
  };
  const attachment = (wallId: number) => {
    const target = modelEditTarget(useViewerStore.getState(), MODEL_ID)!;
    return readTopAttachment(readStoreyInventory(target.dataStore, target.view), wallId);
  };
  const height = (wallId: number) => useViewerStore.getState().readWallEndpoints(MODEL_ID, wallId)?.height;

  it('records the storey above and follows its floor-to-floor edit; a fixed wall keeps its height', () => {
    useViewerStore.getState().setAuthoringDefaults({ wallTop: 'storeyAbove' });
    const attached = draw(0);
    assert.equal(attachment(attached)?.targetStoreyId, UPPER_STOREY);
    useViewerStore.getState().setAuthoringDefaults({ wallTop: 'fixed' });
    const fixed = draw(5);
    assert.equal(attachment(fixed), null);
    const outcome = commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'level', edit: { kind: 'floorHeight', storeyId: STOREY, Height: 3.5 } });
    assert.ok(outcome.ok);
    assert.equal(Math.round(height(attached)! * 1000), 3500);
    assert.equal(Math.round(height(fixed)! * 1000), 3000);
  });

  it('on the top storey records NextStoreyAbove, which the first storey added above binds', () => {
    useViewerStore.getState().setAuthoringDefaults({ wallTop: 'storeyAbove' });
    useViewerStore.getState().setSessionStorey(UPPER_STOREY);
    const wall = draw(0);
    assert.deepEqual(attachment(wall), { targetStoreyId: null, source: 'ifclite' });
    const added = addStoreyNextTo(useViewerStore, MODEL_ID, UPPER_STOREY, 'above', fallback);
    assert.ok(added.ok);
    assert.equal(attachment(wall)?.targetStoreyId, added.storeyId);
  });
});
