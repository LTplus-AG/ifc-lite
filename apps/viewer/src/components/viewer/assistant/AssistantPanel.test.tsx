/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, type, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { AssistantSourceContext, AssistantAction } from './AssistantAction';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { AssistantPanel } from './AssistantPanel';
import { useAssistant, cancelAssistant } from '@/lib/assistant/conversation';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); cancelAssistant(); setValidationSourceChoice(null); useViewerStore.setState(initial, true); });

// #6813: real button wiring and rendered composer state, not source-string assertions.
test('context action opens the registered assistant with frozen evidence and refresh clears the old conversation', () => {
  const source = render(<AssistantSourceContext panel="clash"><AssistantAction /></AssistantSourceContext>);
  click(source.querySelector('button')!);
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'assistant');
  const ui = render(<AssistantPanel />);
  assert.match(ui.textContent ?? '', /Frozen evidence: 0 of 0/);
  const textarea = ui.querySelector('textarea')!;
  type(textarea, 'Explain');
  const send = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Send')!;
  assert.equal(send.disabled, false);
  act(() => useViewerStore.setState({ mutationVersion: initial.mutationVersion + 1 }));
  assert.equal(textarea.disabled, true);
  assert.match(ui.textContent ?? '', /source or model has changed/);
  act(() => useAssistant.setState({ messages: [{ role: 'assistant', content: 'Old result' }] }));
  click([...ui.querySelectorAll('button')].find(button => button.textContent?.includes('Refresh evidence'))!);
  assert.equal(textarea.disabled, false);
  assert.doesNotMatch(ui.textContent ?? '', /Old result/);
});

// The registered host must supply source context to native panel headers.
test('registered Clash and Data validation headers expose the actual contextual action', () => {
  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  const clash = render(renderPanelBody('clash', () => undefined));
  const discuss = clash.querySelector('button[aria-label="Discuss with AI"]');
  assert.ok(discuss, 'Clash native header includes Discuss with AI');
  click(discuss);
  assert.equal(useAssistant.getState().snapshot?.source, 'clash');
  cleanup();
  setValidationSourceChoice('ids');
  const validation = render(renderPanelBody('validation', () => undefined));
  // No report is attached yet, so the source mismatch hides discussion.
  assert.equal(validation.querySelector('button[aria-label="Discuss with AI"]'), null);
  act(() => setValidationSourceChoice('manual'));
  assert.equal(validation.querySelector('button[aria-label="Discuss with AI"]'), null);
});
