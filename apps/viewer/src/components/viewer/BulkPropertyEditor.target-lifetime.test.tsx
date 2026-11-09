/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { BulkQueryEngine, MutablePropertyView } from '@ifc-lite/mutations';
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
async function chooseSource(source: 'selection' | 'search' | 'query') {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Target source"]'); assert.ok(trigger);
  click(trigger); await advance(0);
  const label = source === 'selection' ? 'Selection' : source === 'search' ? 'Search result' : 'Query';
  const item = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent === label);
  assert.ok(item, label); click(item); await advance(0);
}
async function reopen() {
  click(button('Close')!); await advance(0); click(button('Open bulk')!); await advance(0);
  await waitFor(() => !!button('Review as changes') && !button('Review as changes')!.disabled, 'reopened targets finished computing');
}
function setTargets(selection: Array<[string, number]>, search: Array<[string, number]>) {
  act(() => {
    const state = useViewerStore.getState();
    useViewerStore.setState({ selectedEntityIds: new Set(selection.map(([model, id]) => toGlobalIdFromModels(state.models, model, id))),
      selectedEntityId: null, searchFilterResult: { columns: ['model_id', 'express_id'], rows: search, runMs: 0 } });
  });
}
function attribute(model: string, id: number, name = 'Name') {
  return useViewerStore.getState().getMutationView(model)?.getAttributeMutationsForEntity(id).find(m => m.name === name)?.value;
}
async function applyAndWait(jobs: number) {
  assert.equal(applyButton().disabled, false, 'the actual Apply action is available'); click(applyButton());
  await waitFor(() => useActivityJournal.getState().jobs.length === jobs && useActivityJournal.getState().jobs.at(-1)?.outcome === 'completed'
    && applyButton().disabled, 'actual Apply completes and the matching draft is clean');
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
  await chooseSource(source);
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

// #8962: the selected model is A, but the successful operation belongs only to B.
for (const source of ['selection', 'search'] as const) {
  for (const replacement of ['data', 'view'] as const) {
    it(`#8962 clean ${source} draft tracks secondary target ${replacement}, not unrelated model churn`, async () => {
      const { data, views } = await setup(2, 2, source);
      act(() => {
        const state = useViewerStore.getState();
        useViewerStore.setState({
          selectedEntityIds: new Set([10, 11].map(id => toGlobalIdFromModels(state.models, 'b', id))),
          searchFilterResult: { columns: ['model_id', 'express_id'], rows: [['b', 10], ['b', 11]], runMs: 0 },
        });
      });
      await waitFor(() => !applyButton().disabled && applyButton().textContent?.includes('2'), 'B-only targets are ready');
      click(applyButton());
      await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome === 'completed' && applyButton().disabled, 'B Apply completes and stays clean');
      assert.equal(views.get('a')!.getModifiedEntityCount(), 0, 'selected A was not a participant');
      assert.equal(views.get('b')!.getAttributeMutationsForEntity(10).find(m => m.name === 'Name')?.value, 'Applied name');
      // Replacing the maps or even the nonparticipating A data/view must not dirty B.
      const unrelatedData = await operationWalls(2);
      act(() => {
        const state = useViewerStore.getState();
        useViewerStore.setState({ models: new Map(state.models).set('a', { ...state.models.get('a')!, ifcDataStore: unrelatedData }),
          mutationViews: new Map(state.mutationViews).set('a', makeView(unrelatedData, 'a')) });
      });
      await advance(0);
      assert.equal(applyButton().disabled, true, 'unrelated data/view and rebuilt target maps preserve the successful clean draft');
      await reopen();
      assert.equal(applyButton().disabled, true, 'ordinary close/reopen stays clean for the retained source');
      const nextData = replacement === 'data' ? await operationWalls(2) : data;
      act(() => {
        const state = useViewerStore.getState();
        if (replacement === 'data') useViewerStore.setState({ models: new Map(state.models).set('b', { ...state.models.get('b')!, ifcDataStore: nextData }) });
        else state.registerMutationView('b', makeView(data, 'b'));
      });
      await waitFor(() => !applyButton().disabled, 'B replacement re-enables unchanged draft with A still selected');
      click(applyButton());
      await waitFor(() => useActivityJournal.getState().jobs.length === 2 && useActivityJournal.getState().jobs.at(-1)?.outcome === 'completed' && applyButton().disabled, 'reapply completes on current B');
      assert.equal(useViewerStore.getState().getMutationView('b')?.getAttributeMutationsForEntity(11).find(m => m.name === 'Name')?.value, 'Applied name');
      assert.equal(useViewerStore.getState().getMutationView('a')?.getModifiedEntityCount(), 0, 'reapply still does not touch A');
    });
  }
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

// Query chooses B explicitly; Selection/Search keep the model picker on A but target only B.
for (const source of ['query', 'selection', 'search'] as const) {
  for (const replacement of ['data', 'view'] as const) {
    for (const changedModel of ['a', 'b'] as const) {
      it(`#8962 running ${source} B batch ${changedModel === 'a' ? 'survives unrelated A' : 'retires participant B'} ${replacement} replacement`, async () => {
        const { data, views } = await setup(600, 2, source);
        const ids = Array.from({ length: 600 }, (_, i) => ['b', i + 10] as [string, number]);
        setTargets(ids, ids);
        if (source === 'query') await choose('a', 'b');
        await waitFor(() => !applyButton().disabled, 'B targets ready');
        const nextData = replacement === 'data' ? await operationWalls(600) : data;
        let changed = false;
        const off = useActivityJournal.subscribe(({ jobs }) => {
          if (changed || jobs.at(-1)?.progress?.done !== 500) return;
          changed = true;
          act(() => {
            const state = useViewerStore.getState();
            if (replacement === 'data') useViewerStore.setState({ models: new Map(state.models).set(changedModel, { ...state.models.get(changedModel)!, ifcDataStore: nextData }) });
            else state.registerMutationView(changedModel, makeView(data, changedModel));
          });
        });
        try {
          click(applyButton());
          await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome === (changedModel === 'a' ? 'completed' : 'partial'), 'actual participant identity determines completion');
        } finally { off(); }
        assert.equal(changed, true, 'replacement happened at the real 500-write yield');
        assert.equal(views.get('a')!.getModifiedEntityCount(), 0, 'B operation never writes A');
        const last = views.get('b')!.getAttributeMutationsForEntity(609).find(m => m.name === 'Name')?.value;
        assert.equal(last, changedModel === 'a' ? 'Applied name' : undefined, 'unrelated change permits the final write; retired participant forbids it');
        assert.equal(useViewerStore.getState().undoStacks.get('b')?.flat().length,
          changedModel === 'b' ? 500 : source === 'query' ? 601 : 600, 'all and only committed writes remain undoable');
        await waitFor(() => !button('Cancel') && !!button('Review as changes') && !button('Review as changes')!.disabled, 'finished or retired operation releases ownership and refreshes targets');
        assert.equal(activityCanceller(useActivityJournal.getState().jobs.at(-1)!.id), null);
        assert.equal(applyButton().disabled, changedModel === 'a', 'only unchanged successful participants leave the draft clean');
      });
    }
  }
}

for (const source of ['query', 'selection', 'search'] as const) {
  it(`#8962 ${source} choice survives reopen with a conflicting selection and applies the retained draft`, async () => {
    await setup(2, 2, source);
    setTargets([['a', 10]], [['b', 11]]);
    if (source === 'query') await choose('a', 'b');
    await reopen();
    assert.equal(document.querySelector('button[aria-label="Target source"]')?.textContent,
      source === 'query' ? 'Query' : source === 'search' ? 'Search result' : 'Selection');
    await applyAndWait(1);
    assert.equal(attribute('a', 10), source === 'selection' ? 'Applied name' : undefined);
    assert.equal(attribute('b', 10), source === 'query' ? 'Applied name' : undefined);
    assert.equal(attribute('b', 11), source === 'selection' ? undefined : 'Applied name');
    await reopen(); assert.equal(applyButton().disabled, true, 'unchanged reopened draft remains clean after computation settles');
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Value"]'); assert.ok(input);
    type(input, 'Edited after reopen'); await waitFor(() => !applyButton().disabled, 'editing a retained value invalidates the saved semantic draft');
    await applyAndWait(2);
    assert.equal(attribute(source === 'selection' ? 'a' : 'b', source === 'search' ? 11 : 10), 'Edited after reopen');
    assert.equal(attribute(source === 'selection' ? 'b' : 'a', 10), undefined, 'reopen never silently redirects into the other source');
  });
}

it('#8962 action and actual selection edits after clean reopen each enable and apply a new draft', async () => {
  await setup(2, 2, 'selection'); setTargets([['b', 10]], [['a', 11]]);
  await applyAndWait(1); await reopen(); assert.equal(applyButton().disabled, true);
  await choose('Name', 'Description');
  await waitFor(() => !applyButton().disabled, 'changed action field is dirty without a transient result panel');
  await applyAndWait(2); assert.equal(attribute('b', 10, 'Description'), 'Applied name');
  await reopen(); assert.equal(applyButton().disabled, true);
  setTargets([['b', 11]], [['a', 11]]);
  await waitFor(() => !applyButton().disabled, 'changed actual selection is dirty');
  await applyAndWait(3);
  assert.equal(attribute('b', 11, 'Description'), 'Applied name');
  assert.equal(attribute('a', 11, 'Description'), undefined, 'Search and the irrelevant model picker never enter Selection criteria');
});

// Defer delivery of real query IDs, not query semantics, to exercise old error/finally ownership.
for (const operation of ['apply', 'review'] as const) for (const fails of [false, true]) {
  it(`#8962 closed ${operation} ${fails ? 'error' : 'result'} cannot overwrite a reopened operation`, async t => {
    const { views } = await setup(2, 2, 'query'); await choose('a', 'b');
    await waitFor(() => !applyButton().disabled, 'initial query ready');
    const select = BulkQueryEngine.prototype.select;
    const pending: Array<{ resolve: () => void; reject: () => void }> = [];
    let hold = false;
    t.mock.method(BulkQueryEngine.prototype, 'select', function (this: BulkQueryEngine, ...args: Parameters<BulkQueryEngine['select']>) {
      const ids = select.apply(this, args); if (!hold) return ids; hold = false;
      // eslint-disable-next-line unicorn/no-thenable -- retain actual query IDs while controlling async delivery
      return Object.assign(ids, { then(resolve: (ids: number[]) => void, reject: (error: Error) => void) {
        pending.push({ resolve: () => resolve(ids.slice()), reject: () => reject(new Error('Retired query failed')) });
      } });
    });
    const start = () => { hold = true; click(operation === 'apply' ? applyButton() : button('Review as changes')!); };
    try {
      start(); await waitFor(() => pending.length === 1, 'first query suspended');
      await reopen(); start(); await waitFor(() => pending.length === 2, 'new query owns the reopened dialog');
      await act(async () => { if (fails) pending[0].reject(); else pending[0].resolve(); }); await advance(0);
      assert.equal(views.get('b')!.getModifiedEntityCount(), 0, 'retired operation never writes');
      assert.doesNotMatch(document.body.textContent ?? '', /Retired query failed|Review changes/);
      if (operation === 'apply') assert.ok(button('Cancel'), 'old finally cannot clear the new run');
      else { click(applyButton()); await advance(0); assert.equal(useActivityJournal.getState().jobs.length, 0, 'old review finally cannot release the new request owner'); }
      await act(async () => pending[1].resolve());
      if (operation === 'apply') {
        await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome === 'completed', 'current query applies');
        assert.equal(attribute('b', 11), 'Applied name'); assert.equal(attribute('a', 11), undefined);
      } else {
        await waitFor(() => !!document.body.textContent?.includes('Review changes'), 'current query reaches the real review dialog');
        assert.equal(views.get('b')!.getModifiedEntityCount(), 0, 'staging requires separate user confirmation');
      }
    } finally { await act(async () => { for (const item of pending) item.resolve(); }); }
  });
}
