/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mounted artifact reviews (viewer AI P13, #6914) in the Assistant panel over
 * the committed `building-architecture.ifc` sample: proposal cards, the native
 * engine's numbers, the ambiguity pick, saving into the native library and
 * opening it, and refusals.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, test } from 'node:test';
import { act } from 'react';
import { render, click, cleanup, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { loadSavedFilters } from '@/lib/search/saved-filters';
import { seedArtifactModels } from '@/test/artifact-models-fixture';
import { AssistantPanel } from './AssistantPanel';

const initial = useViewerStore.getState();
let seeded: ReturnType<typeof useViewerStore.getState>;
before(async () => { await seedArtifactModels(); seeded = useViewerStore.getState(); });
beforeEach(() => { localStorage.clear(); useViewerStore.setState({ ...seeded, listDefinitions: [], dashboards: [], activeDashboardId: null }, true); });
afterEach(() => { cleanup(); cancelAssistant(); useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' }); });
test.after(() => useViewerStore.setState(initial, true));

function answer(value: Record<string, unknown>) {
  replaceEvidence(captureEvidence('loadReport'));
  act(() => useAssistant.setState({ messages: [{ role: 'user', content: 'Please build it' },
    { role: 'assistant', model: 'recorded', content: JSON.stringify({ version: 1, title: 'Proposal', ...value }) }] }));
  return render(<AssistantPanel />);
}
const button = (ui: HTMLElement, text: string) => [...ui.querySelectorAll('button')].find((b) => b.textContent === text);
const review = (ui: HTMLElement) => ui.querySelector('section[aria-label="Review against the loaded models"]');

test('a chart answer is reviewed with the engine\'s denominator, saved to a dashboard and opened', async () => {
  const ui = answer({ kind: 'chart.proposal', chart: { type: 'bar', dimension: 'IfcType', measure: { agg: 'sum' },
    measureField: { kind: 'quantity', qsetName: 'Qto_SlabBaseQuantities', quantityName: 'NetArea' } } });
  await waitFor(() => /summed over/.test(review(ui)?.textContent ?? ''), 'the chart review ran');
  assert.match(ui.textContent ?? '', /Chart proposal/);
  const text = review(ui)?.textContent ?? '';
  assert.match(text, /Qto_SlabBaseQuantities\.NetArea: 79\.363 m², summed over 3 of 14 rows\./);
  assert.match(text, /11 rows have no value and are not counted\./);
  assert.match(text, /Qto_SlabBaseQuantities\.NetArea: on 3 elements/, 'the checked field and its presence are shown');
  assert.equal(useViewerStore.getState().dashboards.length, 0, 'nothing is saved by review');
  click(button(ui, 'Save to a dashboard')!);
  await waitFor(() => /Saved "Proposal" on the dashboard/.test(ui.textContent ?? ''), 'saved');
  const [dashboard] = useViewerStore.getState().dashboards;
  assert.equal(dashboard.charts[0].measure.agg, 'sum');
  click(button(ui, 'Open the dashboard')!);
  assert.equal(useViewerStore.getState().chartPanelVisible, true);
  assert.equal(useViewerStore.getState().activeDashboardId, dashboard.id);
});

test('an unknown property waits for the user\'s pick among real candidates before anything runs', async () => {
  const ui = answer({ kind: 'list.proposal', list: { name: 'Ratings', entityTypes: ['IfcSlab'], columns: [
    { id: 'name', source: 'attribute', propertyName: 'Name' }, { id: 'rating', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating' }] } });
  await waitFor(() => !!ui.querySelector('[role="group"][aria-label="Pick the fields this means"]'), 'ambiguity shown');
  assert.match(ui.textContent ?? '', /Property Pset_WallCommon\.FireRating \(Column rating\) is not in the loaded models\./);
  assert.equal(button(ui, 'Save to Lists'), undefined, 'no preview and no save until the name resolves');
  assert.equal(button(ui, 'Use the selected fields')?.disabled, true);
  const option = [...ui.querySelectorAll('label')].find((label) => /Pset_SlabCommon\.FireRating/.test(label.textContent ?? ''));
  assert.match(option?.textContent ?? '', /on 1 element in 1 model/);
  act(() => option!.querySelector('input')!.click());
  click(button(ui, 'Use the selected fields')!);
  await waitFor(() => /3 elements matched/.test(review(ui)?.textContent ?? ''), 'list review ran after the pick');
  click(button(ui, 'Save to Lists')!);
  const [saved] = useViewerStore.getState().listDefinitions;
  assert.deepEqual(saved.columns[1], { id: 'rating', source: 'property', psetName: 'Pset_SlabCommon', propertyName: 'FireRating' });
  click(button(ui, 'Open in the list editor')!);
  assert.equal(useViewerStore.getState().pendingListDraft?.id, saved.id);
});

test('a filter answer opens in the native Filter tab on click, without saving', async () => {
  const ui = answer({ kind: 'filter.proposal', name: 'Walls', groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] }] });
  await waitFor(() => /4 elements matched/.test(review(ui)?.textContent ?? ''), 'filter review ran');
  assert.match(ui.textContent ?? '', /Filter proposal/);
  assert.match(ui.textContent ?? '', /1 filter rule/);
  assert.equal(useViewerStore.getState().searchModalOpen, false);
  click(button(ui, 'Open in Filter without saving')!);
  assert.equal(useViewerStore.getState().searchModalOpen, true);
  assert.equal(useViewerStore.getState().searchModalTab, 'filter');
  assert.deepEqual(loadSavedFilters(), [], 'opening is not saving');
});

test('a malformed proposal is a refused card with its reason, never a review', async () => {
  const ui = answer({ kind: 'lens.proposal', lens: { name: 'L', rules: [{ name: 'R', groups: [], action: 'colorize', color: '#E53935' }] } });
  await waitFor(() => /Lens proposal/.test(ui.textContent ?? ''), 'card shown');
  assert.match(ui.textContent ?? '', /Lens rule 1 needs at least one filter group/);
  assert.equal(review(ui), null);
});
