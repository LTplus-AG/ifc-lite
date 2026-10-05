/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { render, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { AssistantPanel } from './AssistantPanel';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); cancelAssistant(); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' }); });

test('a model change answer becomes a proposal card and a native review, never applied by itself', async () => {
  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  replaceEvidence(captureEvidence('loadReport'));
  const answer = JSON.stringify({ version: 1, kind: 'model.changes', title: 'Name walls', changes: [
    { op: 'attribute.set', target: { globalId: '0Wall00000000000000101' }, name: 'Name', expected: 'W1', value: 'Wall 1' }] });
  act(() => useAssistant.setState({ messages: [{ role: 'user', content: 'Fix names' }, { role: 'assistant', model: 'recorded', content: answer }] }));
  const ui = render(<AssistantPanel />);
  for (let i = 0; i < 50 && !ui.querySelector('section[aria-label="Review model changes"]'); i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert.match(ui.textContent ?? '', /Model change proposal/);
  assert.match(ui.textContent ?? '', /1 proposed change/);
  const review = ui.querySelector('section[aria-label="Review model changes"]');
  assert.ok(review, 'the native review card is shown below the conversation');
  assert.match(review.textContent ?? '', /Element not found/, 'targets are resolved against the loaded model, not trusted');
  assert.equal(useViewerStore.getState().undoStacks.size, initial.undoStacks.size, 'nothing is applied without review');
});
