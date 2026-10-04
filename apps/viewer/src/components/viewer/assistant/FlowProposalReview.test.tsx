/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { newFlowDocument } from '@/lib/flow/persistence';
import { FlowProposalReview } from './FlowProposalReview';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); cancelAssistant(); useViewerStore.setState(initial, true); });

// #6822: actual review checkbox gates native graph edits; model output stays inert.
test('mounted Flow review requires approval and enables guarded graph undo', () => {
  const doc = newFlowDocument('Original workflow');
  useViewerStore.setState({ flowDoc: doc, activeFlowId: doc.id, flowRunning: false });
  replaceEvidence(captureEvidence('flow'));
  useAssistant.setState({ messages: [{ role: 'user', content: 'Rename the graph' }, { role: 'assistant', model: 'test-provider',
    content: JSON.stringify({ version: 1, kind: 'flow.patch', operations: [{ op: 'rename', name: 'Reviewed workflow' }] }) }] });
  const ui = render(<FlowProposalReview />);
  const button = (text: string) => [...ui.querySelectorAll('button')].find(b => b.textContent === text)!;
  click(button('Review latest Flow answer'));
  const evidence = ui.querySelector('section[aria-label="Captured evidence context"]');
  assert.ok(evidence);
  assert.match(evidence.textContent ?? '', /Captured workspace evidence/);
  assert.match(evidence.textContent ?? '', /parameters and execution values are excluded/);
  assert.equal(useViewerStore.getState().flowDoc?.name, 'Original workflow');
  assert.equal(button('Apply graph changes').disabled, true);
  assert.match(ui.textContent ?? '', /Additional graph capabilities: None/);
  act(() => ui.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  assert.equal(button('Apply graph changes').disabled, false);
  click(button('Apply graph changes'));
  assert.equal(useViewerStore.getState().flowDoc?.name, 'Reviewed workflow');
  assert.match(ui.textContent ?? '', /No graph execution or model edits were performed/);
  click(button('Undo graph changes'));
  assert.equal(useViewerStore.getState().flowDoc, doc);
});
