/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { configureMutationView } from '@/utils/configureMutationView';
import { render, click, type, cleanup, advance, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { operationWalls } from '@/test/native-operation-fixture';
import { useActivityJournal, activityCanceller } from '@/lib/activity/activity-journal';
import { BulkPropertyEditor } from './BulkPropertyEditor';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial); useActivityJournal.setState({ jobs: [] }); });
const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
function applyButton() {
  const apply = [...document.querySelectorAll('button')].find(node => node.textContent?.includes('Apply to'));
  assert.ok(apply); return apply;
}
async function choose(label: string, option: string) {
  const trigger = [...document.querySelectorAll('[role="combobox"]')].find(node => node.textContent === label);
  assert.ok(trigger); click(trigger); await advance(0);
  const item = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent === option);
  assert.ok(item); click(item); await advance(0);
}
function makeView(data: Awaited<ReturnType<typeof operationWalls>>, id: string) {
  const view = new MutablePropertyView(data.properties ?? null, id);
  configureMutationView(view, data); return view;
}
async function setup(count: number, modelCount = 1, source: 'selection' | 'search' | 'query' = 'selection') {
  useActivityJournal.setState({ jobs: [] });
  const data = await operationWalls(count);
  const models = ['a', 'b'].slice(0, modelCount).map((id, index) => ({
    ...fixtureModel(id, { idOffset: index * 100_000 }), ifcDataStore: data, maxExpressId: count + 9,
  }));
  const state = fixtureModels(...models);
  const ids = Array.from({ length: count }, (_, i) => i + 10);
  const views = new Map(models.map(model => [model.id, makeView(data, model.id)]));
  useViewerStore.setState({ ...state, mutationViews: views, loading: false,
    undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), dirtyModels: new Set(), mutationVersion: 0,
    selectedEntityId: null, selectedEntityIds: new Set(models.flatMap(model => ids.map(id => toGlobalIdFromModels(state.models, model.id, id)))),
    searchModalTab: 'filter', searchFilterResult: { columns: ['model_id', 'express_id'], rows: models.flatMap(model => ids.map(id => [model.id, id])), runMs: 0 },
    editEnabled: true, collabRole: null });
  render(<BulkPropertyEditor trigger={<button>Open bulk</button>} />);
  click(button('Open bulk')!); await advance(0);
  if (source !== 'query') await choose('Query', source === 'selection' ? 'Selection' : 'Search result');
  await choose('Set Property', 'Set Attribute'); await choose('Select attribute', 'Name');
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Value"]'); assert.ok(input);
  type(input, 'Applied name'); await waitFor(() => !applyButton().disabled, 'configured targets enable Apply');
  return { data, views };
}

for (const replacement of ['data', 'view'] as const) {
  it(`#8962 successful clean draft becomes applicable after same-ID ${replacement} replacement`, async () => {
    const { data } = await setup(2, 1, 'query');
    click(applyButton()); await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome === 'completed', 'first Apply completes');
    await waitFor(() => applyButton().disabled, 'completed unchanged draft is clean');
    click(button('Close')!); await advance(0); click(button('Open bulk')!); await advance(0);
    assert.equal(applyButton().disabled, true, 'ordinary close/reopen does not dirty the unchanged target');
    const nextData = replacement === 'data' ? await operationWalls(2) : data;
    act(() => {
      const state = useViewerStore.getState();
      if (replacement === 'data') useViewerStore.setState({ models: new Map(state.models).set('a', { ...state.models.get('a')!, ifcDataStore: nextData }) });
      else state.registerMutationView('a', makeView(data, 'a'));
    });
    await waitFor(() => !applyButton().disabled, 'replacement target enables the retained draft without editing it');
    click(applyButton()); await waitFor(() => useActivityJournal.getState().jobs.length === 2 && useActivityJournal.getState().jobs.at(-1)?.outcome === 'completed', 'retained draft applies again');
    assert.equal(useViewerStore.getState().getMutationView('a')?.getAttributeMutationsForEntity(10).find(m => m.name === 'Name')?.value, 'Applied name');
  });
}

for (const [modelCount, source] of [[1, 'selection'], [2, 'selection'], [2, 'search']] as const) {
  for (const replacement of ['data', 'view'] as const) {
    it(`#8962 ${source} ${modelCount}-model batch retires on ${replacement} replacement during its yield`, async () => {
      const { data, views } = await setup(600, modelCount, source);
      const target = modelCount === 1 ? 'a' : 'b';
      const nextData = replacement === 'data' ? await operationWalls(600) : data;
      const replacementView = makeView(data, target);
      let replaced = false;
      const off = useActivityJournal.subscribe(({ jobs }) => {
        if (replaced || jobs.at(-1)?.progress?.done !== 500) return;
        replaced = true;
        act(() => {
          const state = useViewerStore.getState();
          if (replacement === 'data') useViewerStore.setState({ models: new Map(state.models).set(target, { ...state.models.get(target)!, ifcDataStore: nextData }) });
          else state.registerMutationView(target, replacementView);
        });
      });
      try {
        click(applyButton());
        await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome === 'partial', 'retired batch reports its committed prefix');
      } finally { off(); }
      assert.equal(replaced, true, 'swap occurred at the actual first write-batch yield');
      assert.equal(views.get('a')!.getAttributeMutationsForEntity(10).find(m => m.name === 'Name')?.value, 'Applied name');
      assert.equal(views.get('a')!.getAttributeMutationsForEntity(609).length, 0, 'retired operation cannot finish A');
      if (modelCount === 2) assert.equal(views.get('b')!.getModifiedEntityCount(), 0, 'captured secondary engine never writes after B is replaced');
      if (replacement === 'view') assert.equal(replacementView.getModifiedEntityCount(), 0, 'retired work never redirects into a fresh view');
      assert.equal(useViewerStore.getState().undoStacks.get('a')?.flat().length, 500, 'already committed history remains intact');
      const job = useActivityJournal.getState().jobs.at(-1)!;
      assert.match(job.detail ?? '', /Cancelled after changing 500 entities/);
      assert.equal(activityCanceller(job.id), null);
      await waitFor(() => !applyButton().disabled, 'retired operation releases busy ownership');
      click(applyButton());
      await waitFor(() => useActivityJournal.getState().jobs.length === 2 && useActivityJournal.getState().jobs.at(-1)?.outcome === 'completed', 'fresh target snapshot completes');
      assert.equal(useViewerStore.getState().getMutationView(target)?.getAttributeMutationsForEntity(609).find(m => m.name === 'Name')?.value, 'Applied name');
    });
  }
}
