/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';
import { render, click, type, cleanup, advance, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { operationWalls } from '@/test/native-operation-fixture';
import { activityCanceller, useActivityJournal } from '@/lib/activity/activity-journal';
import { ActivityTrayList } from './activity/ActivityTrayList';
import { BulkPropertyEditor } from './BulkPropertyEditor';
const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial); useActivityJournal.setState({ jobs: [] }); });
const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
async function choose(label: string, option: string) {
  const trigger = [...document.querySelectorAll('[role="combobox"]')].find(node => node.textContent === label);
  assert.ok(trigger); click(trigger); await advance(0);
  const item = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent === option);
  assert.ok(item); click(item); await advance(0);
}
async function setup() {
  useActivityJournal.setState({ jobs: [] });
  const store = await operationWalls();
  const model = { ...fixtureModel('native'), ifcDataStore: store, maxExpressId: 1209 };
  const view = new MutablePropertyView(store.properties ?? null, model.id);
  configureMutationView(view, store);
  useViewerStore.setState({ ...fixtureModels(model), mutationViews: new Map([[model.id, view]]),
    undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), dirtyModels: new Set(), mutationVersion: 0,
    selectedEntityIds: new Set(Array.from({ length: 1200 }, (_, i) => i + 10)), editEnabled: true, collabRole: null });
  render(<><BulkPropertyEditor trigger={<button>Open native bulk</button>} /><ActivityTrayList /></>);
  click(button('Open native bulk')!); await advance(0);
  await choose('Set Property', 'Set Attribute'); await choose('Select attribute', 'Name');
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Value"]');
  assert.ok(input); type(input, 'First applied name'); await advance(250);
  const apply = () => {
    const target = [...document.querySelectorAll('button')].find(node => node.textContent?.includes('Apply to'));
    assert.ok(target && !target.disabled); click(target);
  };
  return { view, input, apply };
}
it('#7128 native bulk Activity Cancel retains exactly one committed batch and old callback cannot cancel retry', async () => {
  const { view, input, apply } = await setup();
  let oldCancel: (() => void) | null = null;
  let stopped = false;
  const off = useActivityJournal.subscribe(({ jobs }) => {
    const row = jobs.at(-1);
    if (stopped || row?.outcome !== 'running' || row.progress?.done !== 500) return;
    stopped = true;
    oldCancel = activityCanceller(row.id);
    assert.ok(oldCancel);
    const cancel = document.querySelector<HTMLButtonElement>('button[aria-label="Cancel Bulk property update"]');
    assert.ok(cancel); click(cancel);
  });
  try { apply(); await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome === 'partial', 'cancelled partial native batch'); }
  finally { off(); }
  assert.equal(view.getAttributeMutationsForEntity(10).find(m => m.name === 'Name')?.value, 'First applied name');
  assert.equal(view.getAttributeMutationsForEntity(1209).length, 0, 'cancelled later batches never write');
  const first = useActivityJournal.getState().jobs[0];
  assert.match(first.detail ?? '', /Cancelled after changing 500 entities.*undo/);
  assert.equal(activityCanceller(first.id), null);
  assert.equal(useViewerStore.getState().undoStacks.get('native')?.flat().length, 500, 'committed writes remain undoable');
  type(input, 'Retry applied name'); await advance(250);
  apply();
  assert.ok(oldCancel); act(() => oldCancel!());
  await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome === 'completed', 'retry completes');
  assert.equal(view.getAttributeMutationsForEntity(1209).find(m => m.name === 'Name')?.value, 'Retry applied name');
  assert.equal(activityCanceller(useActivityJournal.getState().jobs.at(-1)!.id), null);
});
it('#7128 native bulk permission failure reports partial writes without claiming rollback', async () => {
  const { view, apply } = await setup();
  let changed = false;
  const off = useActivityJournal.subscribe(({ jobs }) => {
    if (!changed && jobs.at(-1)?.progress?.done === 500) { changed = true; useViewerStore.setState({ editEnabled: false }); }
  });
  try { apply(); await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome === 'partial', 'partial native failure'); }
  finally { off(); }
  const row = useActivityJournal.getState().jobs.at(-1)!;
  assert.match(row.detail ?? '', /Changed 500 entities; some updates failed.*undo/);
  assert.equal(view.getAttributeMutationsForEntity(10).find(m => m.name === 'Name')?.value, 'First applied name');
  assert.equal(view.getAttributeMutationsForEntity(1209).length, 0);
  assert.equal(activityCanceller(row.id), null);
});
