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
import { act } from 'react';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readTopAttachment, readStoreyInventory } from '@ifc-lite/create';
import { IfcTypeEnum, PropertyValueType, type SpatialHierarchy } from '@ifc-lite/data';
import { StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { setRequestRemesh, type RemeshRequest } from '@/lib/commands/modeling/transaction';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { resolveWallTop } from '@/lib/commands/modeling/wall-top';
import '@/lib/commands/modeling/builtin.js';
import { commandPointerDown, commandPointerMove, writeCommandField } from '@/lib/commands/modeling/runtime';
import { modelEditTarget } from './mutation-modelling-records.js';
import { requiredModule } from '@/i18n/__tests__/required-module';
import { applyLevelDisplayMode, pickTopStorey } from '@/store/levelDisplay';
import { toGlobalIdFromModels } from '@/store/globalId';

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
    assert.ok(m.keepStoreyPreview(useViewerStore));
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

  it('a source without containment relationships keeps its parsed storey contents through an edit, element by element (#9037 review)', async () => {
    const m = await storey();
    const s0 = useViewerStore.getState();
    const target = modelEditTarget(s0, MODEL_ID)!;
    const ds = s0.models.get(MODEL_ID)!.ifcDataStore!;
    const parsedL0 = (function find(node): number[] | undefined {
      if (node.expressId === STOREY) return node.elements;
      for (const child of node.children) { const hit = find(child); if (hit) return hit; }
      return undefined;
    })(ds.spatialHierarchy!.project!);
    assert.ok(parsedL0 && parsedL0.length > 0, 'the fixture lists contents under L0');
    // A native/partial source: the listing is there, the relationships behind it are not.
    for (const rel of readStoreyInventory(target.dataStore, target.view).relationships) {
      if (rel.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE') target.view.deleteEntity(rel.id);
    }
    // One authored wall elsewhere brings a containment relationship of its own.
    const wall = useViewerStore.getState().addWall(MODEL_ID, UPPER_STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok(!('error' in wall));
    assert.ok(m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'rename', storeyId: STOREY, Name: 'Ground' }).ok);
    const s = useViewerStore.getState();
    const project = m.effectiveSpatialProject(ds, s.mutationViews.get(MODEL_ID));
    const find = (node: NonNullable<typeof project>): typeof project => node.expressId === STOREY ? node : node.children.map(find).find(Boolean);
    const l0 = find(project!);
    assert.equal(l0?.name, 'Ground');
    assert.deepEqual(l0?.elements, parsedL0, 'a rename does not empty the parsed contents, even once another storey has live containment');
    const l1 = (function find(node: NonNullable<typeof project>): typeof project { return node.expressId === UPPER_STOREY ? node : node.children.map(find).find(Boolean); })(project!);
    assert.ok(l1?.elements.includes(wall.expressId), 'and the authored wall is listed on its storey');
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

describe('isolation and typed wall heights follow storey edits (#9037 review, round 5)', () => {
  const soloOn = (storeyId: number) => {
    const st = useViewerStore.getState();
    return st.levelDisplayMode === 'solo' && st.selectedStoreys.has(toGlobalIdFromModels(st.models, MODEL_ID, storeyId));
  };

  it('deleting an isolated storey the session does not draw on moves the isolation to the one it does', async () => {
    const m = await storey();
    applyLevelDisplayMode('solo', [{ modelId: MODEL_ID, expressId: UPPER_STOREY }]);
    assert.equal(useViewerStore.getState().session?.storeyId, STOREY);
    assert.ok(m.deleteStorey(useViewerStore, MODEL_ID, UPPER_STOREY, { kind: 'deleteContents' }).ok);
    assert.equal(soloOn(UPPER_STOREY), false, 'the deleted storey is not isolated');
    assert.equal(soloOn(STOREY), true);
    // A deleted storey is never isolated again, though the parsed map still lists it.
    applyLevelDisplayMode('solo', [{ modelId: MODEL_ID, expressId: UPPER_STOREY }]);
    assert.equal(soloOn(UPPER_STOREY), false);
  });

  it('a wall section typed with a height makes an attached wall fixed-height', async () => {
    await storey();
    const target = modelEditTarget(useViewerStore.getState(), MODEL_ID)!;
    const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 9, 0], End: [4, 9, 0], Thickness: 0.2, Height: 3 });
    assert.ok(!('error' in wall));
    const upper = readStoreyInventory(target.dataStore, target.view).storeys.find((x) => x.expressId === UPPER_STOREY)!;
    target.view.setProperty(wall.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', upper.GlobalId, PropertyValueType.Label);
    const { setWallDimensions } = await import('@/components/viewer/model-inspector/inspector-edits');
    assert.ok(setWallDimensions(MODEL_ID, wall.expressId, { thickness: 0.25 }));
    assert.ok(readTopAttachment(readStoreyInventory(target.dataStore, target.view), wall.expressId), 'a thickness alone keeps the attachment');
    assert.ok(setWallDimensions(MODEL_ID, wall.expressId, { height: 2.4 }));
    assert.equal(readTopAttachment(readStoreyInventory(target.dataStore, target.view), wall.expressId), null);
  });

  it('the general element-size edit fixes an attached wall it gives a height (#9037 review)', async () => {
    await storey();
    const target = modelEditTarget(useViewerStore.getState(), MODEL_ID)!;
    const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 10, 0], End: [4, 10, 0], Thickness: 0.2, Height: 3 });
    assert.ok(!('error' in wall));
    const upper = readStoreyInventory(target.dataStore, target.view).storeys.find((x) => x.expressId === UPPER_STOREY)!;
    target.view.setProperty(wall.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', upper.GlobalId, PropertyValueType.Label);
    const { setElementDimensions } = await import('@/components/viewer/model-inspector/inspector-edits');
    assert.ok(setElementDimensions(MODEL_ID, wall.expressId, { kind: 'wall', height: 2.4 }));
    assert.equal(readTopAttachment(readStoreyInventory(target.dataStore, target.view), wall.expressId), null);
  });
});

describe('previews and hierarchy rows follow storey edits (#9037 review, round 11)', () => {
  it('Escape on a preview another write has buried still puts the level back, and keeps that write', async () => {
    const m = await storey();
    const preview = m.previewStoreyLevel(useViewerStore, MODEL_ID, { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.4 });
    assert.ok(preview.applied);
    // A script writes on top of the provisional edit.
    const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 12, 0], End: [4, 12, 0], Thickness: 0.2, Height: 3 });
    assert.ok(!('error' in wall));
    m.revertStoreyPreview(useViewerStore);
    assert.deepEqual(storeys(), [['L0', 0], ['L1', 3]], 'the cancelled elevation is gone');
    assert.equal(useViewerStore.getState().mutationViews.get(MODEL_ID)!.isDeleted(wall.expressId), false, 'the later write stays');
  });

  it('Escape on a buried floor-to-floor preview restores each storey, even after a storey was added below it (#9037 review)', async () => {
    const m = await storey();
    assert.ok(m.previewStoreyLevel(useViewerStore, MODEL_ID, { kind: 'floorHeight', storeyId: STOREY, Height: 4 }).applied);
    // A script adds a storey at 2 m, between L0 and the previewed L1 (now at 4 m).
    const added = m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'add', params: { Name: 'Mezzanine', Elevation: 2, referenceStoreyId: STOREY } });
    assert.ok(added.ok);
    m.revertStoreyPreview(useViewerStore);
    assert.deepEqual(storeys(), [['L0', 0], ['Mezzanine', 2], ['L1', 3]], 'L1 is back at 3 m; the new storey stays at 2 m');
  });

  it('a buried preview whose restore is refused returns the refusal instead of closing quietly (#9037 review)', async () => {
    const m = await storey();
    assert.ok(m.previewStoreyLevel(useViewerStore, MODEL_ID, { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.4 }).applied);
    assert.ok(m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'add', params: { Name: 'Mid', Elevation: 3.2, referenceStoreyId: STOREY } }).ok);
    const refused = m.revertStoreyPreview(useViewerStore);
    assert.ok(refused && !refused.ok, 'L1 cannot cross the storey added at 3.2 m');
    assert.deepEqual(storeys(), [['L0', 0], ['Mid', 3.2], ['L1', 3.4]]);
  });

  it('a new preview is not applied while the buried one cannot be put back (#9037 review)', async () => {
    const m = await storey();
    assert.ok(m.previewStoreyLevel(useViewerStore, MODEL_ID, { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.4 }).applied);
    assert.ok(m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'add', params: { Name: 'Mid', Elevation: 3.2, referenceStoreyId: STOREY } }).ok);
    const next = m.previewStoreyLevel(useViewerStore, MODEL_ID, { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.5 });
    assert.equal(next.applied, false);
    assert.ok(next.outcome && !next.outcome.ok, 'the stuck restore is reported');
    assert.deepEqual(storeys(), [['L0', 0], ['Mid', 3.2], ['L1', 3.4]], 'no second provisional edit on top');
  });

  it('a buried multi-storey cancel is one Undo step (#9037 review)', async () => {
    const m = await storey();
    assert.ok(m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'add', params: { Name: 'L2', Elevation: 6, referenceStoreyId: UPPER_STOREY } }).ok);
    assert.ok(m.previewStoreyLevel(useViewerStore, MODEL_ID, { kind: 'floorHeight', storeyId: STOREY, Height: 4 }).applied);
    const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 11, 0], End: [4, 11, 0], Thickness: 0.2, Height: 3 });
    assert.ok(!('error' in wall));
    assert.equal(m.revertStoreyPreview(useViewerStore), null);
    assert.deepEqual(storeys(), [['L0', 0], ['L1', 3], ['L2', 6]], 'cancelled');
    act(() => { useViewerStore.getState().undo(MODEL_ID); });
    assert.deepEqual(storeys(), [['L0', 0], ['L1', 4], ['L2', 7]], 'one Undo takes the whole cancel back, not part of it');
  });

  it('a buried multi-storey restore is all or nothing: a refusal partway leaves the preview whole (#9037 review)', async () => {
    const m = await storey();
    assert.ok(m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'add', params: { Name: 'L2', Elevation: 6, referenceStoreyId: UPPER_STOREY } }).ok);
    // L0 0 / L1 3 / L2 6; a 4 m gap above L0 moves L1 to 4 and L2 to 7.
    assert.ok(m.previewStoreyLevel(useViewerStore, MODEL_ID, { kind: 'floorHeight', storeyId: STOREY, Height: 4 }).applied);
    assert.ok(m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'add', params: { Name: 'Mid', Elevation: 6.5, referenceStoreyId: UPPER_STOREY } }).ok);
    const redoBefore = useViewerStore.getState().redoStacks.get(MODEL_ID)?.length ?? 0;
    const refused = m.revertStoreyPreview(useViewerStore);
    assert.ok(refused && !refused.ok, 'L2 cannot go back across the storey at 6.5 m');
    assert.deepEqual(storeys(), [['L0', 0], ['L1', 4], ['Mid', 6.5], ['L2', 7]], 'L1 is not left half-cancelled');
    assert.equal(useViewerStore.getState().redoStacks.get(MODEL_ID)?.length ?? 0, redoBefore, 'the rolled-back restore leaves no redo');
  });

  it('a preview a script has undone is not reported as kept (#9037 review)', async () => {
    const m = await storey();
    assert.ok(m.previewStoreyLevel(useViewerStore, MODEL_ID, { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.4 }).applied);
    act(() => { useViewerStore.getState().undo(MODEL_ID); });
    assert.equal(m.keepStoreyPreview(useViewerStore), false, 'Enter must apply the edit itself');
    assert.deepEqual(storeys(), [['L0', 0], ['L1', 3]]);
  });

  it('a preview a script has written over is not reported as kept (#9037 review)', async () => {
    const m = await storey();
    assert.ok(m.previewStoreyLevel(useViewerStore, MODEL_ID, { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.5 }).applied);
    assert.ok(m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'level', edit: { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 4 } }).ok);
    assert.equal(m.keepStoreyPreview(useViewerStore), false, 'Enter must apply the typed value itself');
  });

  it('a partial tree\'s row that is only in byStorey shows the live name and elevation (#9037 review)', async () => {
    const m = await storey();
    const { buildUnifiedStoreys } = await import('@/components/viewer/hierarchy/treeDataBuilder');
    assert.ok(m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'rename', storeyId: UPPER_STOREY, Name: 'Upper' }).ok);
    assert.ok(m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'level', edit: { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.5 } }).ok);
    const s = useViewerStore.getState();
    const base = s.models.get(MODEL_ID)!;
    const ds = base.ifcDataStore!;
    // The partial tree's root is not the storeys' parent: they are byStorey rows the tree
    // never had, and the effective tree has nowhere to re-attach them.
    const root = { expressId: 999_999, type: IfcTypeEnum.IfcProject, name: 'Partial', children: [], elements: [] };
    const hierarchy = { ...ds.spatialHierarchy!, project: root };
    const partial = { ...base, ifcDataStore: { ...ds, spatialHierarchy: hierarchy } };
    const view = s.mutationViews.get(MODEL_ID)!;
    const models = new Map([[MODEL_ID, partial], ['peer', { ...partial, id: 'peer', name: 'Peer' }]]) as unknown as Parameters<typeof buildUnifiedStoreys>[0];
    const row = buildUnifiedStoreys(models, undefined, undefined, undefined, undefined, (id) => (id === MODEL_ID ? view : null))
      .flatMap((unified) => unified.storeys).find((r) => r.modelId === MODEL_ID && r.storeyId === UPPER_STOREY);
    assert.ok(row, 'the byStorey-only row is listed');
    assert.deepEqual([row.name, row.elevation], ['Upper', 3.5]);
  });

  it('an empty storey added under a building a partial tree omits is still listed (#9037 review)', async () => {
    const m = await storey();
    const { buildUnifiedStoreys } = await import('@/components/viewer/hierarchy/treeDataBuilder');
    const added = m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'add', params: { Name: 'Roof', Elevation: 6, referenceStoreyId: UPPER_STOREY } });
    assert.ok(added.ok && added.storeyId !== null);
    const s = useViewerStore.getState();
    const base = s.models.get(MODEL_ID)!;
    const ds = base.ifcDataStore!;
    // A tree that exists but never reaches the storeys' parent.
    const root = { expressId: 999_998, type: IfcTypeEnum.IfcProject, name: 'Partial', children: [], elements: [] };
    const partial = { ...base, ifcDataStore: { ...ds, spatialHierarchy: { ...ds.spatialHierarchy!, project: root } } };
    const view = s.mutationViews.get(MODEL_ID)!;
    const models = new Map([[MODEL_ID, partial], ['peer', { ...partial, id: 'peer', name: 'Peer' }]]) as unknown as Parameters<typeof buildUnifiedStoreys>[0];
    const rows = buildUnifiedStoreys(models, undefined, undefined, undefined, undefined, (id) => (id === MODEL_ID ? view : null))
      .flatMap((unified) => unified.storeys).filter((r) => r.modelId === MODEL_ID);
    assert.ok(rows.some((r) => r.storeyId === added.storeyId), 'the new storey is listed');
    assert.equal(rows.filter((r) => r.storeyId === added.storeyId).length, 1, 'once');
  });

  it('level display reads an edited elevation live, and an untouched one from the parse', async () => {
    const m = await storey();
    const { effectiveLevelElevations } = await import('@/lib/effective-level-elevations');
    assert.ok(m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'level', edit: { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.5 } }).ok);
    const s = useViewerStore.getState();
    const live = effectiveLevelElevations(s.models.get(MODEL_ID)!.ifcDataStore!, s.mutationViews.get(MODEL_ID)!, [STOREY, UPPER_STOREY]);
    assert.deepEqual([...live], [[STOREY, 0], [UPPER_STOREY, 3.5]]);
  });

  it('without a project tree, a unified storey row shows the live name and elevation, and a deleted storey is gone', async () => {
    const m = await storey();
    const { buildUnifiedStoreys } = await import('@/components/viewer/hierarchy/treeDataBuilder');
    assert.ok(m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'rename', storeyId: STOREY, Name: 'Ground' }).ok);
    assert.ok(m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'level', edit: { kind: 'elevation', storeyId: UPPER_STOREY, Elevation: 3.5 } }).ok);
    const s = useViewerStore.getState();
    const base = s.models.get(MODEL_ID)!;
    const ds = base.ifcDataStore!;
    const hierarchy = { ...ds.spatialHierarchy! };
    Object.defineProperty(hierarchy, 'project', { value: undefined });
    const treeless = { ...base, ifcDataStore: { ...ds, spatialHierarchy: hierarchy } };
    const peer = { ...treeless, id: 'peer', name: 'Peer' };
    const view = s.mutationViews.get(MODEL_ID)!;
    const models = new Map([[MODEL_ID, treeless], ['peer', peer]]) as unknown as Parameters<typeof buildUnifiedStoreys>[0];
    const rows = buildUnifiedStoreys(models, undefined, undefined, undefined, undefined, (id) => (id === MODEL_ID ? view : null))
      .flatMap((unified) => unified.storeys.filter((row) => row.modelId === MODEL_ID).map((row) => [row.name, row.elevation]));
    assert.deepEqual(rows.sort((a, b) => Number(a[1]) - Number(b[1])), [['Ground', 0], ['L1', 3.5]]);
  });
});

describe('a storey added to a source without a project tree (#9037 review, round 13)', () => {
  // A storey something is drawn on is registered in the parsed `byStorey` map
  // (`registerAuthoredElement`); an empty new storey is only in the overlay.
  it('gets its own unified hierarchy row while it is still empty', async () => {
    const m = await storey();
    const { buildUnifiedStoreys } = await import('@/components/viewer/hierarchy/treeDataBuilder');
    const added = m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'add', params: { Name: 'Roof', Elevation: 6, referenceStoreyId: UPPER_STOREY } });
    assert.ok(added.ok && added.storeyId !== null);
    const s = useViewerStore.getState();
    const base = s.models.get(MODEL_ID)!;
    const ds = base.ifcDataStore!;
    const hierarchy = { ...ds.spatialHierarchy! };
    Object.defineProperty(hierarchy, 'project', { value: undefined });
    const treeless = { ...base, ifcDataStore: { ...ds, spatialHierarchy: hierarchy } };
    const view = s.mutationViews.get(MODEL_ID)!;
    const models = new Map([[MODEL_ID, treeless], ['peer', { ...treeless, id: 'peer', name: 'Peer' }]]) as unknown as Parameters<typeof buildUnifiedStoreys>[0];
    const row = buildUnifiedStoreys(models, undefined, undefined, undefined, undefined, (id) => (id === MODEL_ID ? view : null))
      .flatMap((unified) => unified.storeys).find((r) => r.modelId === MODEL_ID && r.storeyId === added.storeyId);
    assert.ok(row, 'the new storey is listed');
    assert.equal(row.name, 'Roof');
    assert.equal(row.elevation, 6);
    assert.deepEqual(row.elements, []);
  });
});

describe('bim.store storey reads in the viewer (#9037 review)', () => {
  it('listStoreyLevels fails for a model with no editable data instead of reporting no storeys', async () => {
    const { storeyMethods } = await requiredModule(() => import('@/sdk/adapters/store-adapter-storey-impl'), 'the viewer storey adapter exists');
    const methods = storeyMethods(useViewerStore);
    assert.ok(methods.listStoreyLevels(MODEL_ID).length >= 2);
    assert.throws(() => methods.listStoreyLevels('missing-model'), /No model loaded/);
  });

  it('a script deleting the storey being drawn on moves the session off it first', async () => {
    const { storeyMethods } = await requiredModule(() => import('@/sdk/adapters/store-adapter-storey-impl'), 'the viewer storey adapter exists');
    useViewerStore.getState().setSessionStorey(UPPER_STOREY);
    storeyMethods(useViewerStore).deleteStorey({ modelId: MODEL_ID, expressId: UPPER_STOREY }, { kind: 'empty' });
    assert.equal(useViewerStore.getState().session?.storeyId, STOREY, 'the workspace draws on a live storey');
  });

  // #9200: the store adapter's modelling methods no longer carry the SDK's own
  // storey methods. `bim.store`'s storey calls must still reach the viewer's
  // tracked path: one undo step per write, listed straight after.
  it('the store adapter answers storey calls through the tracked storey path (#9200)', async () => {
    const { createStoreAdapter } = await import('@/sdk/adapters/store-adapter');
    const { loadStoreyAdapter } = await import('@/sdk/adapters/store-adapter-storey');
    const api = createStoreAdapter(useViewerStore);
    await loadStoreyAdapter();
    assert.ok(api.addStorey && api.listStoreyLevels && api.deleteStorey, 'the adapter offers the storey methods');
    const before = batches();
    const roof = api.addStorey(MODEL_ID, { Name: 'Roof', Elevation: 6, referenceStoreyId: UPPER_STOREY });
    assert.equal(batches(), before + 1, 'the write is one undo step on the viewer history');
    assert.ok(api.listStoreyLevels(MODEL_ID).some((row) => row.expressId === roof.expressId && row.Name === 'Roof'));
    api.deleteStorey(roof, { kind: 'empty' });
    assert.ok(!api.listStoreyLevels(MODEL_ID).some((row) => row.expressId === roof.expressId));
  });

  it('the Solo fallback ranks live elevations: a storey added above the parsed top is the top', async () => {
    const m = await storey();
    const outcome = m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'add', params: { Name: 'Roof', Elevation: 6, referenceStoreyId: UPPER_STOREY } });
    assert.ok(outcome.ok && outcome.storeyId !== null);
    assert.deepEqual(pickTopStorey(), { modelId: MODEL_ID, expressId: outcome.storeyId });
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
    assert.deepEqual(attachment(wall), { targetStoreyId: null, kind: 'storey', binding: 'relative', source: 'ifclite' });
    const added = m.addStoreyNextTo(useViewerStore, MODEL_ID, UPPER_STOREY, 'above', fallback);
    assert.ok(added.ok);
    assert.equal(attachment(wall)?.targetStoreyId, added.storeyId);
  });

  it('a wall on an upper storey measures to the next storey from its own floor, not world zero (#9037 review)', async () => {
    const m = await storey();
    // L0 at 0 m, L1 at 3 m, L2 at 6 m: a wall on L1 reaches L2, 3 m up.
    const roof = m.commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'add', params: { Name: 'L2', Elevation: 6, referenceStoreyId: UPPER_STOREY } });
    assert.ok(roof.ok && roof.storeyId !== null);
    useViewerStore.getState().setAuthoringDefaults({ wallTop: 'storeyAbove' });
    useViewerStore.getState().setSessionStorey(UPPER_STOREY);
    const drawn = draw(0);
    assert.equal(attachment(drawn)?.targetStoreyId, roof.storeyId);
    assert.equal(Math.round(height(drawn)! * 1000), 3000, 'the Wall tool');
    assert.equal(useViewerStore.getState().readWallEndpoints(MODEL_ID, drawn)?.start[2], 0, 'endpoints are storey-local');
    // The inspector's "Storey above" on a fixed wall of L1 computes the same.
    const fixed = useViewerStore.getState().addWall(MODEL_ID, UPPER_STOREY, { Start: [0, 6, 0], End: [4, 6, 0], Thickness: 0.2, Height: 2 });
    assert.ok(!('error' in fixed));
    const { setWallTop } = await import('@/components/viewer/model-inspector/WallTopRow');
    assert.ok(setWallTop(MODEL_ID, fixed.expressId, 'storeyAbove'));
    assert.equal(Math.round(height(fixed.expressId)! * 1000), 3000, 'the inspector');
  });

  it('the inspector, like the Wall tool, keeps a wall fixed-height when the storey above is under 0.1 m away (#9037 review)', async () => {
    await storey();
    // A wall starting 2.95 m above L0, with L1 at 3 m: attaching would make it 0.05 m tall.
    const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 7, 2.95], End: [4, 7, 2.95], Thickness: 0.2, Height: 0.5 });
    assert.ok(!('error' in wall));
    const { setWallTop } = await import('@/components/viewer/model-inspector/WallTopRow');
    assert.equal(setWallTop(MODEL_ID, wall.expressId, 'storeyAbove'), false, 'refused, not attached as a sliver');
    assert.equal(attachment(wall.expressId), null);
    assert.equal(height(wall.expressId), 0.5);
    useViewerStore.getState().setAuthoringDefaults({ wallTop: 'storeyAbove' });
    const tool = resolveWallTop(useViewerStore.getState(), MODEL_ID, STOREY, 2.95);
    assert.equal(tool.attachTo, null, 'the Wall tool falls back to fixed height for the same input');
  });

  it('typing the storey spacing itself still makes the wall fixed at that height', () => {
    useViewerStore.getState().setAuthoringDefaults({ wallTop: 'storeyAbove' });
    useViewerStore.getState().startCommand('wall.place');
    writeCommandField(3, 3); // Height: exactly the spacing up to L1
    assert.equal(useViewerStore.getState().authoringDefaults.wallTop, 'fixed');
    assert.equal(attachment(draw(0)), null);
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
