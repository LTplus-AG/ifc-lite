/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { render, click, cleanup, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { loadSavedFilters } from '@/lib/search/saved-filters';
import { installClassificationModels, namedClassificationModel, selectorAnswer } from '@/test/classification-selector-fixture';
import { ArtifactProposalReview } from './ArtifactProposalReview';
import type { ArtifactProposal } from '@/lib/assistant/artifacts/proposal-kinds';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); cancelAssistant(); useViewerStore.setState(initial, true); useAssistant.setState({ messages: [], snapshot: null, archived: null, status: 'idle', error: null }); });
const saveButton = (ui: HTMLElement) => [...ui.querySelectorAll('button')].find(button => /^Save to /.test(button.textContent ?? ''));

function review(kind: ArtifactProposal['kind'], system: string) {
  act(() => useAssistant.setState({ status: 'idle', error: null, messages: [{ role: 'assistant', model: 'recorded', content: selectorAnswer(kind, system) }] }));
  return render(<ArtifactProposalReview onAsk={null} />);
}

for (const kind of ['filter.proposal', 'list.proposal', 'lens.proposal', 'chart.proposal'] as const) {
  test(`#7130 mounted ${kind} waits for explicit classification-system choice before native Save`, async () => {
    installClassificationModels(await namedClassificationModel());
    const filtersBefore = loadSavedFilters().length;
    const before = useViewerStore.getState();
    const ui = review(kind, 'uniclass2015');
    await waitFor(() => /Classification system uniclass2015/.test(ui.textContent ?? ''), 'invented alias is a classification ambiguity');
    assert.equal(saveButton(ui), undefined, 'unknown selector cannot publish a broader missing-value population');
    assert.equal(useViewerStore.getState().dashboards.length, 0);
    assert.equal(useViewerStore.getState().listDefinitions.length, 0);
    assert.equal(useViewerStore.getState().savedLenses.length, before.savedLenses.length);
    const radio = ui.querySelector<HTMLInputElement>('input[type="radio"]');
    assert.ok(radio, 'only a real discovered system is offered');
    assert.match(radio.closest('label')?.textContent ?? '', /Uniclass 2015/);
    click(radio);
    const choose = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Use the selected fields');
    assert.ok(choose);
    click(choose);
    await waitFor(() => !!saveButton(ui) && !saveButton(ui)?.disabled, 'known native selector finishes review');
    assert.match(ui.textContent ?? '', /Uniclass 2015: classification system available/);
    assert.match(ui.textContent ?? '', /2 elements matched/);
    click(saveButton(ui)!);
    const state = useViewerStore.getState();
    if (kind === 'filter.proposal') {
      assert.equal(loadSavedFilters().length, filtersBefore + 1);
      assert.ok(loadSavedFilters().at(-1)?.groups.some(group => group.rules.some(rule => rule.kind === 'classification' && rule.system === 'Uniclass 2015')));
    } else if (kind === 'list.proposal') assert.equal(state.listDefinitions.length, 1);
    else if (kind === 'lens.proposal') assert.equal(state.savedLenses.length, before.savedLenses.length + 1);
    else assert.equal(state.dashboards.length, 1);
  });
}

test('#7130 model replacement withdraws mounted classification preview and stale Save', async () => {
  installClassificationModels(await namedClassificationModel());
  const ui = review('chart.proposal', 'Uniclass 2015');
  await waitFor(() => !!saveButton(ui) && !saveButton(ui)?.disabled, 'initial native classification chart');
  const staleSave = saveButton(ui)!;
  const replacement = await namedClassificationModel('OmniClass');
  act(() => installClassificationModels(replacement));
  click(staleSave);
  await waitFor(() => /Classification system Uniclass 2015.*not in the loaded models/.test(ui.textContent ?? ''), 'the new federation cannot reuse the old classification catalog');
  assert.equal(useViewerStore.getState().dashboards.length, 0);
  assert.equal(saveButton(ui)?.disabled ?? true, true);
});
