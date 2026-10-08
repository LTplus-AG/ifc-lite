/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { IfcTypeEnum } from '@ifc-lite/data';
import { Rule } from '@ifc-lite/rules';
import type { ListDefinition } from '@ifc-lite/lists';
import { render, click, cleanup, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { operationWalls } from '@/test/native-operation-fixture';
import { useViewerStore } from '@/store';
import { activityCanceller, useActivityJournal } from '@/lib/activity/activity-journal';
import { ActivityTrayList } from '../activity/ActivityTrayList';
import { ListPanel } from './ListPanel';
const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial); useActivityJournal.setState({ jobs: [] }); });
const definition: ListDefinition = { id: 'operation-walls', name: 'Native wall inventory', createdAt: 0, updatedAt: 0,
  entityTypes: [IfcTypeEnum.IfcWall], groups: [{ combinator: 'AND', rules: [Rule.name('contains', 'Wall')] }],
  columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }] };
async function setup(count = 1) {
  useActivityJournal.setState({ jobs: [] });
  const store = await operationWalls();
  const models = Array.from({ length: count }, (_, i) => ({ ...fixtureModel(`native-${i}`, { idOffset: i * 1000000 }),
    ifcDataStore: store, maxExpressId: 1209 }));
  useViewerStore.setState({ ...fixtureModels(...models), listDefinitions: [definition], activeListId: null,
    listResult: null, listError: null, listExecuting: false, pendingListDraft: null,
    modelTags: new Map(), modelTagAssignments: new Map(), zoneSets: [], zoneAssignments: {} });
  const ui = render(<><ListPanel /><ActivityTrayList /></>);
  const run = () => {
    const button = ui.querySelector<HTMLButtonElement>('button[aria-label="Run list Native wall inventory"]');
    assert.ok(button); click(button);
  };
  return { ui, run };
}
for (const count of [1, 2]) it(`#7128 native list Activity cancellation owns only its invocation (models.size=${count})`, async () => {
  const { ui, run } = await setup(count);
  run();
  const first = useActivityJournal.getState().jobs[0];
  assert.ok(first, 'native list run appears in Activity');
  const oldCancel = activityCanceller(first.id);
  assert.ok(oldCancel);
  const cancel = ui.querySelector<HTMLButtonElement>('button[aria-label="Cancel List execution"]');
  assert.ok(cancel); click(cancel);
  await waitFor(() => useActivityJournal.getState().jobs[0]?.outcome === 'cancelled', 'cancelled native list settled');
  assert.equal(useViewerStore.getState().listResult, null, 'late cancelled native result cannot publish');
  assert.equal(activityCanceller(first.id), null);
  run(); oldCancel();
  await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome === 'completed', 'next native list completes');
  const result = useViewerStore.getState().listResult;
  assert.equal(result?.totalCount, 1200 * count, 'native federation population is complete');
  assert.equal(new Set(result?.rows.map(row => row.modelId)).size, count);
  assert.equal(activityCanceller(useActivityJournal.getState().jobs.at(-1)!.id), null);
});
it('#7128 closing the native list panel retains its established abort-on-unmount and cleans its Activity row', async () => {
  const { run } = await setup();
  run(); const first = useActivityJournal.getState().jobs[0];
  cleanup();
  await waitFor(() => useActivityJournal.getState().jobs[0]?.outcome === 'cancelled', 'native unmount cancellation settled');
  assert.equal(useViewerStore.getState().listResult, null);
  assert.equal(activityCanceller(first.id), null);
});
