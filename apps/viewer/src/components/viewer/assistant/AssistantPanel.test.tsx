/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, type, press, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { AssistantSourceContext, AssistantAction } from './AssistantAction';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { AssistantPanel } from './AssistantPanel';
import { UNCONFIGURED_MODEL_ID } from '@/lib/llm/models';
import { useAssistant, cancelAssistant, replaceEvidence } from '@/lib/assistant/conversation';
import { captureEvidence } from '@/lib/assistant/evidence';
import { summarizeClashes, type Clash } from '@ifc-lite/clash';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); setValidationSourceChoice(null); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

// #6813: real button wiring and rendered composer state, not source-string assertions.
test('context action opens the registered assistant with frozen evidence and refresh clears the old conversation', () => {
  const source = render(<AssistantSourceContext panel="clash"><AssistantAction /></AssistantSourceContext>);
  click(source.querySelector('button')!);
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'assistant');
  const ui = render(<AssistantPanel />);
  assert.match(ui.textContent ?? '', /No native clash result was available at capture/);
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
  // #6833: the manual side discusses the manual checklist (human verdicts), not the IDS report.
  act(() => setValidationSourceChoice('manual'));
  const manual = validation.querySelector('button[aria-label="Discuss with AI"]');
  assert.ok(manual, 'the manual side offers its own source');
  click(manual);
  assert.equal(useAssistant.getState().snapshot?.source, 'manualChecklist');
});

test('fingerprint replacement renders stale evidence and disables sending through the canonical guard (#6839)', () => {
  useViewerStore.setState(fixtureModels({ ...fixtureModel('m'), sourceFingerprint: 'original' }));
  const source = render(<AssistantSourceContext panel="clash"><AssistantAction /></AssistantSourceContext>);
  click(source.querySelector('button')!);
  const ui = render(<AssistantPanel />);
  const textarea = ui.querySelector('textarea')!;
  type(textarea, 'Explain captured results');
  assert.equal(textarea.disabled, false);
  act(() => useViewerStore.setState(fixtureModels({ ...fixtureModel('m'), sourceFingerprint: 'replacement' })));
  assert.equal(textarea.disabled, true);
  assert.match(ui.textContent ?? '', /Stale workspace evidence/);
  const send = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Send')!;
  assert.equal(send.disabled, true);
});

// Conversation-first panel: guidance before the first turn, typed proposals as cards, keyboard send.
test('suggestions fill the composer, Enter sends and typed proposals render as review cards instead of raw JSON', () => {
  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  const source = render(<AssistantSourceContext panel="clash"><AssistantAction /></AssistantSourceContext>);
  click(source.querySelector('button')!);
  const ui = render(<AssistantPanel />);
  const textarea = ui.querySelector('textarea')!;
  const suggestion = ui.querySelector<HTMLButtonElement>('fieldset[aria-label="Suggested questions"] button')!;
  click(suggestion);
  assert.equal(textarea.value, suggestion.textContent);

  act(() => useViewerStore.setState({ chatActiveModel: UNCONFIGURED_MODEL_ID }));
  press(textarea, 'Enter', { shiftKey: true });
  assert.equal(useAssistant.getState().error, null, 'Shift+Enter keeps editing');
  press(textarea, 'Enter');
  assert.equal(useAssistant.getState().error, 'missing-model', 'Enter submits through the real send path');
  assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /No AI model is configured/);

  const proposal = JSON.stringify({ version: 1, kind: 'clash.groups', groups: [{ name: 'Slab joins', explanation: 'Inference', citations: ['E1', 'E2'] }] });
  act(() => useAssistant.setState({ status: 'idle', error: null, messages: [{ role: 'user', content: 'Group' }, { role: 'assistant', model: 'recorded', content: proposal }] }));
  assert.match(ui.textContent ?? '', /Clash grouping proposal/);
  assert.match(ui.textContent ?? '', /1 group · 2 findings cited/);
  assert.equal(ui.querySelector('fieldset[aria-label="Suggested questions"]'), null, 'suggestions give way to the conversation');
  const json = [...ui.querySelectorAll('pre')].find(pre => pre.textContent === proposal);
  assert.ok(json?.closest('details'), 'raw JSON is only available behind Show JSON');
});

// #6873: the Assistant is a starting point, not a dead end that sends the user elsewhere.
test('opening the Assistant without evidence offers every source with its live status and attaches in place', () => {
  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  const ui = render(<AssistantPanel />);
  assert.match(ui.textContent ?? '', /What do you want to discuss\?/);
  assert.equal(ui.querySelector('textarea')!.disabled, true);
  const row = (title: string) => [...ui.querySelectorAll('li')].find(li => li.querySelector('span')?.textContent === title)!;
  assert.match(row('Clash detection').textContent ?? '', /Not run yet/);
  assert.ok([...row('Clash detection').querySelectorAll('button')].some(b => b.textContent === 'Run clash detection'));
  assert.match(row('Compare models').textContent ?? '', /Needs two models/);
  assert.match(row('Load report').textContent ?? '', /1 model/);
  click(ui.querySelector('button[aria-label="Discuss Load report"]')!);
  assert.equal(useAssistant.getState().snapshot?.source, 'loadReport');
  assert.equal(ui.querySelector('textarea')!.disabled, false);
  assert.match(ui.textContent ?? '', /1 of 1 rows attached/);
  click(ui.querySelector('button[aria-label="Discuss something else"]')!);
  assert.match(ui.textContent ?? '', /What do you want to discuss\?/);
  click([...ui.querySelectorAll('button')].find(b => b.textContent === 'Cancel')!);
  assert.equal(useAssistant.getState().snapshot?.source, 'loadReport', 'cancelling keeps the attached source');
});

test('citations open the captured row and clash rows offer the native model focus', () => {
  const clash: Clash = { id: 'c1', rule: 'coordination', status: 'hard', severity: 'major', distance: -0.02, distanceKind: 'estimate',
    a: { model: 'a', key: 'wall', ref: 1, tag: 'IfcWall' }, b: { model: 'a', key: 'pipe', ref: 2, tag: 'IfcPipeSegment' },
    point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
  const result = { clashes: [clash], summary: summarizeClashes([clash]), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
  useViewerStore.setState({ clashResult: result, clashRawResult: result });
  replaceEvidence(captureEvidence('clash'));
  act(() => useAssistant.setState({ messages: [{ role: 'user', content: 'Where?' }, { role: 'assistant', model: 'recorded', content: '## Finding\n\nThe wall [E1] is hit.' }] }));
  const ui = render(<AssistantPanel />);
  assert.equal(ui.querySelector('h2 + *, p')?.textContent?.startsWith('##'), false);
  click(ui.querySelector('button[data-citation="E1"]')!);
  const peek = ui.querySelector('section[aria-label="Captured row E1"]')!;
  assert.ok(peek, 'citation opens its captured row');
  assert.match(peek.textContent ?? '', /a\.tag\s*IfcWall/);
  assert.ok([...peek.querySelectorAll('button')].some(b => b.textContent === 'Show this clash in the model'), 'live clash rows can be focused');
  act(() => useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 }));
  assert.equal([...ui.querySelectorAll('button')].some(b => b.textContent === 'Show this clash in the model'), false, 'stale evidence never drives the scene');
});
