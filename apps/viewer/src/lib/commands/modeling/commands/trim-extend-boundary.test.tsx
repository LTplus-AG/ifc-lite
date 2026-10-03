/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { beforeEach, afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { StepExporter } from '@ifc-lite/export';
import { readWallJoinTarget } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { buildStoreyWorkplane, isWorkplane } from '../workplane.js';
import { prepareModel, boundaryOfTarget } from './trim-extend-model.js';
import { previewFor } from './trim-extend-plan.js';
import { commitTrimExtend } from './trim-extend-commit.js';
import { meshStairs, stairMeshBounds, stairWasmAvailable } from '../../../../../../../packages/create/src/in-store/__test__/stair-mesh.oracle.js';
const state = () => useViewerStore.getState();
const built = (r: {expressId:number} | {error:string}) => { assert.ok('expressId' in r); return r.expressId; };
beforeEach(async () => { await seedModelingSession(); });
afterEach(() => { state().exitModelWorkspace(); });
for (const unit of ['metre', 'millimetre'] as const) for (const kind of ['wall', 'beam'] as const) {
  it(`#6232 / #6752 ${unit} ${kind}: a previewed line from an unreadable wall boundary commits without an invented join`, async t => {
    if (!stairWasmAvailable) { t.skip('pnpm build:wasm to run native boundary geometry'); return; }
    await seedModelingSession({unit});
    const boundaryId = built(state().addWall(MODEL_ID, STOREY, {Start:[0,4,0],End:[8,4,0],Thickness:.2,Height:3}));
    const id = kind === 'wall'
      ? built(state().addWall(MODEL_ID, STOREY, {Start:[4,0,0],End:[4,3,0],Thickness:.2,Height:3}))
      : built(state().addBeam(MODEL_ID, STOREY, {Start:[4,0,3],End:[4,3,3],Width:.3,Height:.5}));
    const edit = modelEditTarget(state(), MODEL_ID)!;
    const scale = unit === 'metre' ? 1 : .001;
    const boundaryRead = readWallJoinTarget(edit.dataStore, edit.view, boundaryId, scale)!;
    const plane = buildStoreyWorkplane(state(), MODEL_ID, STOREY, 0);
    assert.ok(isWorkplane(plane));
    const model = prepareModel(state(), MODEL_ID, STOREY, plane);
    const target = model.targets.find(x => x.expressId === id)!;
    const picked = boundaryOfTarget(model.targets.find(x => x.expressId === boundaryId)!);
    assert.ok(picked);
    // IFC's omitted RefDirection defaults to +X: the physical horizontal
    // boundary is valid, although the strict join reader requires explicit axes.
    edit.editor.setPositionalAttribute(boundaryRead.axisPlacementId, 2, null);
    assert.equal(readWallJoinTarget(edit.dataStore, edit.view, boundaryId, scale), null);
    const boundary = {...picked, wall:null};
    const plan = previewFor(state(), target, boundary, 'extend', [4,2.9]);
    assert.ok(plan.ok, 'the explicit boundary line has an accepted ghost');
    assert.equal(plan.joinKind, null, 'preview did not plan a physical wall join');
    const text = () => new TextDecoder().decode(new StepExporter(edit.dataStore, edit.view).export({schema:'IFC4',applyMutations:true,timeStamp:'2026-10-03T00:00:00'}).content);
    const beforeText = text(), beforeMesh = await meshStairs(beforeText);
    const history = state().undoStacks.get(MODEL_ID)?.length ?? 0;
    const result = commitTrimExtend({modelId:MODEL_ID,storeyId:STOREY,workplane:plane,batchId:'boundary-control',store:state(),api:useViewerStore}, target, boundary, plan);
    assert.deepEqual(result.remesh, [id], 'only the chosen target changes');
    const written = (state().undoStacks.get(MODEL_ID) ?? []).slice(history);
    assert.ok(written.length > 0);
    assert.deepEqual([...new Set(written.map(m => state().mutationBatchTags.get(m.id)))], ['boundary-control'], 'all changed helpers share one Undo batch');
    const afterMesh = await meshStairs(text());
    assert.deepEqual(afterMesh.get(boundaryId), beforeMesh.get(boundaryId), 'native boundary geometry remains unchanged');
    const box = stairMeshBounds(afterMesh.get(id)!);
    assert.ok(Math.abs(box.max[1] - 4) < 1e-5, 'native target reaches the same boundary axis shown by the preview');
    state().undo(MODEL_ID);
    const entityRows = (step: string) => step.split('\n').filter(row => row.startsWith('#')).sort();
    assert.deepEqual(entityRows(text()), entityRows(beforeText), 'one Undo restores every exported entity and relationship, regardless of legal STEP ordering');
  });
}
