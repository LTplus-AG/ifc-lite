/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store`'s structural methods in the viewer load their builders in their
 * own chunk (#9668). The adapter starts the load when it is built; a call that
 * arrives first is refused by name, and the same adapter answers once loaded.
 *
 * The refusal test must run before anything in this process loads the chunk,
 * so it is first and nothing above it imports the implementation.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { extractStructuralOnDemand } from '@ifc-lite/parser';
import { effectiveStructuralView } from '@/components/viewer/properties/effectiveStructuralView';
import { useViewerStore } from '@/store';
import { GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { createStoreAdapter } from './store-adapter.js';
import { loadStructuralWrites } from './store-adapter-structural.js';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

const STRUCTURAL_METHODS = [
  'addStructuralAnalysisModel', 'addStructuralCurveMember', 'addStructuralPointConnection',
  'addStructuralSurfaceMember', 'addStructuralCurveConnection', 'addStructuralSurfaceConnection',
  'addStructuralLoadGroup', 'addStructuralPointAction', 'addStructuralLinearAction',
  'connectStructuralMemberToConnection', 'connectStructuralActivityToItem', 'assignToStructuralGroup',
] as const;

const member = { Name: 'Script member', Start: [0, 0, 0] as [number, number, number], End: [4, 0, 0] as [number, number, number], PredefinedType: 'RIGID_JOINED_MEMBER' as const };

test('a structural call before the write path loads is refused by name, then the same adapter writes (#9668)', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY)!;
  const api = createStoreAdapter(useViewerStore);
  for (const name of STRUCTURAL_METHODS) assert.equal(typeof api[name], 'function', `bim.store.${name} is offered from boot`);

  assert.throws(() => api.addStructuralCurveMember(SAMPLE_MODEL, storey, member),
    /^Error: bim\.store\.addStructuralCurveMember: structural authoring is still loading/);
  assert.throws(() => api.addStructuralAnalysisModel(SAMPLE_MODEL, { Name: 'Early', PredefinedType: 'LOADING_3D' }),
    /^Error: bim\.store\.addStructuralAnalysisModel: structural authoring is still loading/);
  assert.equal(extractStructuralOnDemand(dataStore, view).members.length, 0, 'a refused call writes nothing');

  await loadStructuralWrites();
  const undoBefore = useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0;
  const ref = api.addStructuralCurveMember(SAMPLE_MODEL, storey, member);
  assert.equal(ref.modelId, SAMPLE_MODEL);
  const live = useViewerStore.getState().mutationViews.get(SAMPLE_MODEL) ?? view;
  const members = extractStructuralOnDemand(dataStore, live).members;
  assert.deepEqual(members.map((row) => [row.expressId, row.name]), [[ref.expressId, 'Script member']]);
  assert.equal(useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length, undoBefore + 1, 'one undo step, as before the split');
});

test('structural edit and owned removal each undo as one operation (#9668)', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY)!;
  const api = createStoreAdapter(useViewerStore);
  await loadStructuralWrites();
  const ref = api.addStructuralCurveMember(SAMPLE_MODEL, storey, member);
  const state = () => useViewerStore.getState();
  const rows = () => extractStructuralOnDemand(dataStore, effectiveStructuralView(state().mutationViews.get(SAMPLE_MODEL) ?? view, dataStore)).members;
  api.editStructuralEntity!(SAMPLE_MODEL, ref.expressId, { Name: 'Edited member', Description: 'Edited description' });
  assert.equal(rows()[0].name, 'Edited member');
  state().undo(SAMPLE_MODEL);
  assert.equal(rows()[0].name, 'Script member');
  assert.notEqual(rows()[0].description, 'Edited description');
  state().redo(SAMPLE_MODEL);
  assert.equal(rows()[0].name, 'Edited member');
  const count = state().mutationViews.get(SAMPLE_MODEL)!.getNewEntities().length;
  api.removeStructuralEntity!(SAMPLE_MODEL, ref.expressId);
  assert.equal(rows().length, 0);
  state().undo(SAMPLE_MODEL);
  assert.equal(rows()[0].name, 'Edited member');
  assert.equal(state().mutationViews.get(SAMPLE_MODEL)!.getNewEntities().length, count);
  state().redo(SAMPLE_MODEL);
  assert.equal(rows().length, 0);
});
