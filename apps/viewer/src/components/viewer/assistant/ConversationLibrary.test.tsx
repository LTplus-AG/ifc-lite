/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, type, cleanup } from '@/test/render';
import { AssistantPanel } from './AssistantPanel';
import { assistantLibrary, useAssistantLibrary } from '@/lib/assistant/library';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { readContentRows } from '@/lib/storage/content-database';

afterEach(() => { cleanup(); cancelAssistant(); });

// #6820: mounted save/open controls exercise actual IDB and archived composer gating.
test('save keeps the inspected evidence and opening a saved conversation disables sends until refresh', async () => {
  await assistantLibrary.initialize();
  replaceEvidence(captureEvidence('clash'));
  const payload = useAssistant.getState().snapshot!.payload;
  const ui = render(<AssistantPanel />);
  type(ui.querySelector<HTMLInputElement>('#assistant-conversation-name')!, 'Model coordination');
  await act(async () => {
    click([...ui.querySelectorAll('button')].find(b => b.textContent === 'Save conversation')!);
    const deadline = Date.now() + 2000;
    while (!Object.values(useAssistantLibrary.getState().status.items).includes('saved') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });
  const rows = await readContentRows('assistant');
  assert.equal(rows.length, 1);
  assert.equal(useAssistantLibrary.getState().entries[0].evidence.payload, payload);
  act(() => useAssistant.setState({ snapshot: null, messages: [] }));
  click([...ui.querySelectorAll('button')].find(b => b.textContent === 'Model coordination')!);
  assert.match(ui.textContent ?? '', /Saved evidence is archived/);
  assert.equal(ui.querySelector<HTMLTextAreaElement>('#assistant-prompt')!.disabled, true);
  click([...ui.querySelectorAll('button')].find(b => b.textContent?.includes('Refresh evidence'))!);
  assert.equal(ui.querySelector<HTMLTextAreaElement>('#assistant-prompt')!.disabled, false);
  assert.equal(useAssistant.getState().archived, null);
  assert.equal(useAssistant.getState().messages.length, 0);
});
