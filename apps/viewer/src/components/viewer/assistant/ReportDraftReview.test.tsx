/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, cleanup, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { validateDocumentSpec } from '@/lib/document/types';
import { ReportDraftReview } from './ReportDraftReview';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); cancelAssistant(); useViewerStore.setState(initial, true); });

// #6830: mount the actual user control and commit through native document storage.
test('mounted report review requires explicit approval before creating an editable native document', async () => {
  replaceEvidence(captureEvidence('clash'));
  useAssistant.setState({ messages: [{ role: 'user', content: 'Summarize' },
    { role: 'assistant', model: 'actual-provider', content: 'No analysis rows were supplied; no verdict can be established.' }] });
  const ui = render(<ReportDraftReview />);
  const button = (text: string) => [...ui.querySelectorAll('button')].find(button => button.textContent === text)!;
  click(button('Prepare report draft'));
  assert.equal(button('Save reviewed document').disabled, true);
  assert.equal(button('Export reviewed document JSON').disabled, true);
  act(() => ui.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  assert.equal(button('Save reviewed document').disabled, false);
  click(button('Save reviewed document'));
  await waitFor(() => /Document saved with captured historical evidence/.test(ui.textContent ?? ''), 'reviewed document committed');
  const document = useViewerStore.getState().documents.find(doc => doc.name === 'Analysis report draft');
  assert.ok(document);
  assert.deepEqual(validateDocumentSpec(document), []);
  assert.ok(document.blocks.some(block => block.kind === 'text' && block.text.includes('no verdict can be established')));
  click(button('Open document'));
  assert.equal(useViewerStore.getState().activeDocumentId, document.id);
});
