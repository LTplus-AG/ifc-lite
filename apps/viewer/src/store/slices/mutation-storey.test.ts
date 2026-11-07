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
import { IfcTypeEnum, PropertyValueType, type SpatialHierarchy } from '@ifc-lite/data';
import { StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { setRequestRemesh, type RemeshRequest } from '@/lib/commands/modeling/transaction';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import '@/lib/commands/modeling/builtin.js';
import { commandPointerDown, commandPointerMove, writeCommandField } from '@/lib/commands/modeling/runtime';
import { modelEditTarget } from './mutation-modelling-records.js';
import { requiredModule } from '@/i18n/__tests__/required-module';

/** The new write path, loaded per test so a production revert fails an assertion, not the file load. */
const storey = () => requiredModule(async () => ({
  ...(await import('./mutation-storey.js')),
  ...(await import('@/lib/storeys/storey-actions')),
  ...(await import('@/lib/storeys/storey-preview')),
  ...(await import('@/components/viewer/hierarchy/effectiveStoreyNodes')),
}), 'the viewer storey write path exists (#9013)');

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
/** Distinct undo steps on the stack; an untagged record fails here rather than reading as one shared step. */
const batches = () => {
  const s = useViewerStore.getState();
  const tags = (s.undoStacks.get(MODEL_ID) ?? []).map((m) => s.mutationBatchTags.get(m.id));
  assert.ok(tags.every((tag) => tag !== undefined), 'every undo record carries a batch tag');
  return new Set(tags).size;
};

describe('storey ops in the viewer (#9013)', () => {
  it('adds a storey above the top one, makes it the drawing storey, and lists it in the tree', async () => {
    const m = await storey();
    const outcome = m.addStoreyNextTo(useViewerStore, MODEL_ID, UPPER_STOREY, 'above', fallback);
    assert.ok(outcome.ok);
    assert.ok(outcome.storeyId !== null);
    assert.equal(useViewerStore.getState().session?.storeyId, outcome.storeyId, 'the new storey is the one being drawn on');
    assert.equal(storeys().at(-1)?.[1], 6, 'spacing repeats the storey below');
    assert.equal(batches(), 1, 'one undo step');
    const s = useViewerStore.getState();
    const project = m.effectiveSpatialProject(s.models.get(MODEL_ID)!.ifcDataStore!, s.mutationViews.get(MODEL_ID));
    const found: number[] = [];
    const walk = (node: NonNullable<typeof project>) => { found.push(node.expressId); node.children.forEach(walk); };
    walk(project!);
    assert.ok(found.includes(outcome.storeyId!), 'the hierarchy lists the new storey');

    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(storeys().length, 2, 'undo removes it again');
  });

  it('draws a wall on a new storey: the wall is contained there', async () => {
    const m = await storey();
    const outcome = m.addStoreyNextTo(useViewerStore, MODEL_ID, UPPER_STOREY, 'above', fallback);
    assert.ok(outcome.ok && outcome.storeyId !== null);
    const wall = useViewerStore.getState().addWall(MODEL_ID, outcome.storeyId!, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok(!('error' in wall));
    const target = modelEditTarget(useViewerStore.getState(), MODEL_ID)!;
    const inventory = readStoreyInventory(target.dataStore, target.view);
    assert.equal(inventory.storeys.find((s) => s.expressId === outcome.storeyId)?.elevation, 6);
    // Contained by the new storey itself, not merely placed at its height.
    const contained = (inventory.outgoing.get(outcome.storeyId!) ?? [])
      .filter((rel) => rel.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE').flatMap((rel) => rel.children);
    assert.ok(contained.includes(wall.expressId), 'the new storey contains the wall');
  });

  it('re-levels as one undo step and re-meshes what moved', async () => {
    const m = await storey();
    const wall = useViewerStore.getState().addWall(MODEL_ID, UPPER_STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok(!('error' in wall));
    const depth = undoDepth();
    remeshed = [];
    const outcome = m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'level', edit: { kind: 'floorHeight', storeyId: STOREY, Height: 3.5 } });
    assert.ok(outcome.ok);
    assert.deepEqual(storeys().map(([, e]) => e), [0, 3.5]);
    assert.ok(remeshed.some((r) => r.expressIds.includes(wall.expressId)), 'the wall on the moved storey is re-meshed');
    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), depth);
    assert.deepEqual(storeys().map(([, e]) => e), [0, 3]);
    useViewerStore.getState().redo(MODEL_ID);
    assert.deepEqual(storeys().map(([, e]) => e), [0, 3.5]);
  });

  it('refuses an invalid edit with the reason and leaves history untouched', async () => {
    const m = await storey();
    const depth = undoDepth();
    const outcome = m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'level', edit: { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: -1 } });
    assert.ok(!outcome.ok);
    assert.equal(outcome.refusals[0]?.code, 'crossing');
    assert.equal(undoDepth(), depth);
    assert.deepEqual(storeys().map(([, e]) => e), [0, 3]);
  });

  it('previews for real, reverts on cancel with the redo history restored, and keeps on Enter as one step', async () => {
    const m = await storey();
    const depth = undoDepth();
    const preview = m.previewStoreyLevel(useViewerStore, MODEL_ID, { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.4 });
    assert.ok(preview.applied);
    assert.deepEqual(storeys().map(([, e]) => e), [0, 3.4], 'the model shows the edit while it is typed');
    m.revertStoreyPreview(useViewerStore);
    assert.deepEqual(storeys().map(([, e]) => e), [0, 3]);
    assert.equal(undoDepth(), depth);
    assert.equal(useViewerStore.getState().redoStacks.get(MODEL_ID)?.length ?? 0, 0, 'cancelling leaves nothing to redo');

    m.previewStoreyLevel(useViewerStore, MODEL_ID, { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.2 });
    m.previewStoreyLevel(useViewerStore, MODEL_ID, { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.6 });
    assert.ok(m.keepStoreyPreview());
    assert.deepEqual(storeys().map(([, e]) => e), [0, 3.6]);
    // The hierarchy follows each preview, though every one adds as many records as the last (#9037 review).
    const s = useViewerStore.getState();
    const project = m.effectiveSpatialProject(s.models.get(MODEL_ID)!.ifcDataStore!, s.mutationViews.get(MODEL_ID));
    const find = (node: NonNullable<typeof project>): typeof project => node.expressId === UPPER_STOREY ? node : node.children.map(find).find(Boolean);
    assert.equal(find(project!)?.elevation, 3.6, 'the tree shows the kept elevation, not a cached earlier preview');
    assert.equal(batches(), 1, 'typing two values then Enter is one undo step');
  });

  it('deleting the drawing storey moves the session to a live one first', async () => {
    const m = await storey();
    useViewerStore.getState().setSessionStorey(UPPER_STOREY);
    const outcome = m.deleteStorey(useViewerStore, MODEL_ID, UPPER_STOREY, { kind: 'empty' });
    assert.ok(outcome.ok);
    assert.equal(useViewerStore.getState().session?.storeyId, STOREY);
    assert.deepEqual(storeys().map(([name]) => name).length, 1);
  });

  it('a deletion reviewed in the panel refuses contents added since, and deletes nothing (#9013 review)', async () => {
    const m = await storey();
    const reviewed = m.reviewStoreyDeletion(useViewerStore.getState(), MODEL_ID, UPPER_STOREY);
    assert.ok(reviewed);
    const target = modelEditTarget(useViewerStore.getState(), MODEL_ID)!;
    const editor = new StoreEditor(target.dataStore, target.view);
    const late = editor.addEntity('IfcWall', ['3JUHrTM_j3UxZiBnyBfByx', null, 'Late', null, null, null, null, null, null]).expressId;
    editor.addEntity('IfcRelContainedInSpatialStructure', ['3tI3d7B1T4ivX8X0SA4yuM', null, null, null, [`#${late}`], `#${UPPER_STOREY}`]);
    const depth = undoDepth();
    // Drawing on the storey being deleted: a refused deletion leaves the session where it was.
    useViewerStore.getState().setSessionStorey(UPPER_STOREY);
    const outcome = m.deleteStorey(useViewerStore, MODEL_ID, UPPER_STOREY, { kind: 'deleteContents' }, reviewed);
    assert.ok(!outcome.ok);
    assert.equal(outcome.refusals[0]?.code, 'stale');
    assert.equal(useViewerStore.getState().session?.storeyId, UPPER_STOREY, 'the session is back on the storey that stays');
    // Moving the contents is held to the same review: the wall added since is not moved unseen.
    const moved = m.deleteStorey(useViewerStore, MODEL_ID, UPPER_STOREY, { kind: 'move', targetStoreyId: STOREY }, reviewed);
    assert.ok(!moved.ok);
    assert.equal(moved.refusals[0]?.code, 'stale');
    assert.equal(target.view.isDeleted(late), false, 'the wall added after the review survives');
    assert.equal(undoDepth(), depth);
    assert.equal(storeys().length, 2);
    // Reviewed again, the deletion goes through with the wall.
    assert.ok(m.deleteStorey(useViewerStore, MODEL_ID, UPPER_STOREY, { kind: 'deleteContents' }, m.reviewStoreyDeletion(useViewerStore.getState(), MODEL_ID, UPPER_STOREY)!).ok);
    assert.equal(target.view.isDeleted(late), true);
  });
});

describe('the hierarchy and the inspector follow storey edits (#9037 review)', () => {
  it('a wall moved off a deleted storey is listed on the storey it moved to', async () => {
    const m = await storey();
    const wall = useViewerStore.getState().addWall(MODEL_ID, UPPER_STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok(!('error' in wall));
    assert.ok(m.deleteStorey(useViewerStore, MODEL_ID, UPPER_STOREY, { kind: 'move', targetStoreyId: STOREY }).ok);
    const s = useViewerStore.getState();
    const project = m.effectiveSpatialProject(s.models.get(MODEL_ID)!.ifcDataStore!, s.mutationViews.get(MODEL_ID));
    const find = (node: NonNullable<typeof project>): typeof project => node.expressId === STOREY ? node : node.children.map(find).find(Boolean);
    assert.ok(find(project!)?.elements.includes(wall.expressId), 'the remaining storey lists the moved wall');
  });

  it('levels the parsed rows had that are not building storeys survive an edit', async () => {
    const m = await storey();
    const part = { expressId: 900, type: IfcTypeEnum.IfcFacilityPart, name: 'Deck', children: [], elements: [901] };
    const level = { expressId: 40, type: IfcTypeEnum.IfcBuildingStorey, name: 'L0', children: [], elements: [41] };
    const project = { expressId: 1, type: IfcTypeEnum.IfcProject, name: 'P', children: [level, part], elements: [] };
    const edited = { ...project, children: [{ ...level, name: 'Ground' }, part] };
    const hierarchy = { project, byStorey: new Map([[40, [41]], [900, [901]]]) } as unknown as SpatialHierarchy;
    const index = new Map([[40, edited.children[0]], [900, part]]);
    const rows = m.effectiveStoreyRows(hierarchy, edited, index).map(([id, elements]) => [id, [...elements]]);
    assert.deepEqual(rows, [[40, [41]], [900, [901]]]);
  });

  it('a level a partial tree never had keeps its row when another storey is edited', async () => {
    const m = await storey();
    const level = { expressId: 40, type: IfcTypeEnum.IfcBuildingStorey, name: 'L0', children: [], elements: [41] };
    const gone = { expressId: 50, type: IfcTypeEnum.IfcBuildingStorey, name: 'L1', children: [], elements: [51] };
    const project = { expressId: 1, type: IfcTypeEnum.IfcProject, name: 'P', children: [level, gone], elements: [] };
    const edited = { ...project, children: [{ ...level, name: 'Ground' }] };
    // 60 is listed by the source but absent from its tree; 50 was in the tree and is now deleted.
    const hierarchy = { project, byStorey: new Map([[40, [41]], [50, [51]], [60, [61]]]) } as unknown as SpatialHierarchy;
    const index = new Map([[40, edited.children[0]]]);
    const rows = m.effectiveStoreyRows(hierarchy, edited, index).map(([id, elements]) => [id, [...elements]]);
    assert.deepEqual(rows, [[40, [41]], [60, [61]]]);
  });

  it('typing a height in the inspector makes an attached wall fixed-height, in one undo step', async () => {
    const m = await storey();
    void m;
    useViewerStore.getState().setSessionStorey(STOREY);
    const target = modelEditTarget(useViewerStore.getState(), MODEL_ID)!;
    const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 8, 0], End: [4, 8, 0], Thickness: 0.2, Height: 3 });
    assert.ok(!('error' in wall));
    const upper = readStoreyInventory(target.dataStore, target.view).storeys.find((x) => x.expressId === UPPER_STOREY)!;
    target.view.setProperty(wall.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', upper.GlobalId, PropertyValueType.Label);
    const { setWallHeightFixed } = await import('@/components/viewer/model-inspector/WallTopRow');
    const before = undoDepth();
    assert.ok(setWallHeightFixed(MODEL_ID, wall.expressId, 2.4));
    assert.equal(readTopAttachment(readStoreyInventory(target.dataStore, target.view), wall.expressId), null, 'the wall is fixed-height now');
    assert.equal(useViewerStore.getState().readWallEndpoints(MODEL_ID, wall.expressId)?.height, 2.4);
    // The records this edit added (the resize and the cleared attachment) form one tagged undo step.
    const s = useViewerStore.getState();
    const added = (s.undoStacks.get(MODEL_ID) ?? []).slice(before).map((record) => s.mutationBatchTags.get(record.id));
    assert.ok(added.length > 1 && added.every((tag) => tag !== undefined), 'every new record carries a batch tag');
    assert.equal(new Set(added).size, 1, 'one undo step');
  });
});

describe('bim.store storey reads in the viewer (#9037 review)', () => {
  it('listStoreyLevels fails for a model with no editable data instead of reporting no storeys', async () => {
    const { storeyMethods } = await requiredModule(() => import('@/sdk/adapters/store-adapter-storey-impl'), 'the viewer storey adapter exists');
    const methods = storeyMethods(useViewerStore);
    assert.ok(methods.listStoreyLevels(MODEL_ID).length >= 2);
    assert.throws(() => methods.listStoreyLevels('missing-model'), /No model loaded/);
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

  it('records the storey above and follows its floor-to-floor edit; a fixed wall keeps its height', async () => {
    const m = await storey();
    useViewerStore.getState().setAuthoringDefaults({ wallTop: 'storeyAbove' });
    const attached = draw(0);
    assert.equal(attachment(attached)?.targetStoreyId, UPPER_STOREY);
    useViewerStore.getState().setAuthoringDefaults({ wallTop: 'fixed' });
    const fixed = draw(5);
    assert.equal(attachment(fixed), null);
    const outcome = m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'level', edit: { kind: 'floorHeight', storeyId: STOREY, Height: 3.5 } });
    assert.ok(outcome.ok);
    assert.equal(Math.round(height(attached)! * 1000), 3500);
    assert.equal(Math.round(height(fixed)! * 1000), 3000);
  });

  it('on the top storey records NextStoreyAbove, which the first storey added above binds', async () => {
    const m = await storey();
    useViewerStore.getState().setAuthoringDefaults({ wallTop: 'storeyAbove' });
    useViewerStore.getState().setSessionStorey(UPPER_STOREY);
    const wall = draw(0);
    assert.deepEqual(attachment(wall), { targetStoreyId: null, source: 'ifclite' });
    const added = m.addStoreyNextTo(useViewerStore, MODEL_ID, UPPER_STOREY, 'above', fallback);
    assert.ok(added.ok);
    assert.equal(attachment(wall)?.targetStoreyId, added.storeyId);
  });

  it('a height typed on the top storey makes the wall fixed instead of waiting for the storey above', () => {
    useViewerStore.getState().setAuthoringDefaults({ wallTop: 'storeyAbove' });
    useViewerStore.getState().setSessionStorey(UPPER_STOREY);
    useViewerStore.getState().startCommand('wall.place');
    writeCommandField(3, 2.4); // Height
    assert.equal(useViewerStore.getState().authoringDefaults.wallTop, 'fixed');
    const wall = draw(0);
    assert.equal(attachment(wall), null, 'no NextStoreyAbove is recorded');
    assert.equal(Math.round(height(wall)! * 1000), 2400);
  });
});
