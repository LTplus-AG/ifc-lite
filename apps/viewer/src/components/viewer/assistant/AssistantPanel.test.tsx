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
import { setGenerationLanguagePreference, useGenerationLanguagePreference } from '@/lib/assistant/language';
import { setAssistantDraft } from '@/lib/assistant/composer-draft';
import { useAssistantPlacement } from '@/lib/assistant/placement';
import { summarizeClashes, type Clash } from '@ifc-lite/clash';

const initial = useViewerStore.getState();
const initialGenerationLanguage = useGenerationLanguagePreference.getState().language;
const initialPlacement = useAssistantPlacement.getState();
afterEach(() => {
  setGenerationLanguagePreference(initialGenerationLanguage);
  cleanup(); setAssistantDraft(''); cancelAssistant(); setValidationSourceChoice(null); useViewerStore.setState(initial, true);
  useAssistantPlacement.setState(initialPlacement, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

// #6813: real button wiring and rendered composer state, not source-string assertions.
test('context action opens the registered assistant with frozen evidence and refresh clears the old conversation', () => {
  useAssistantPlacement.setState({ placement: 'split' });
  useViewerStore.setState({ sidebarActivePanel: 'clash' });
  const source = render(<AssistantSourceContext panel="clash"><AssistantAction /></AssistantSourceContext>);
  click(source.querySelector('button')!);
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'clash', 'the source remains visible');
  assert.equal(useViewerStore.getState().sidebarSecondaryPanel, 'assistant');
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


test('#6926 an unsent composer draft survives a host remount and stays editable', () => {
  replaceEvidence(captureEvidence('clash'));
  const first = render(<AssistantPanel />);
  type(first.querySelector('textarea')!, 'Explain these collisions before publication');
  cleanup();
  const second = render(<AssistantPanel />);
  const prompt = second.querySelector('textarea')!;
  assert.equal(prompt.value, 'Explain these collisions before publication');
  assert.equal(prompt.disabled, false);
  type(prompt, 'Revised request');
  assert.equal(prompt.value, 'Revised request');
});


test('#6926 answer language changes the conversation without replacing evidence or the editable draft', () => {
  replaceEvidence(captureEvidence('clash'));
  const evidence = useAssistant.getState().snapshot;
  const ui = render(<AssistantPanel />);
  type(ui.querySelector('textarea')!, 'Keep this question');
  const language = ui.querySelector<HTMLSelectElement>('#assistant-generation-language');
  assert.ok(language, 'the answer language control is mounted');
  act(() => { language.value = 'de'; language.dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.equal(useAssistant.getState().language.generation, 'de');
  assert.equal(useAssistant.getState().snapshot, evidence);
  assert.equal(ui.querySelector('textarea')!.value, 'Keep this question');
  act(() => useAssistant.setState({ status: 'streaming' }));
  assert.equal(language.disabled, true, 'an in-flight request keeps its captured language');
  assert.equal(ui.querySelector('textarea')!.disabled, false, 'the next question stays editable');
});


test('#7053 language extensions survive portable conversation decoding and malformed tags are refused', async () => {
  const { decodeConversation } = await import('@/lib/assistant/persistence');
  const evidence = captureEvidence('clash');
  const entry = { version: 1, id: 'language-record', name: 'Language record', savedAt: new Date().toISOString(), model: 'recorded-model',
    evidence: { source: evidence.source, capturedAt: evidence.capturedAt, payload: evidence.payload,
      totalRows: evidence.totalRows, includedRows: evidence.includedRows, projectionTruncated: evidence.projectionTruncated },
    messages: [], language: { ui: 'en', generation: 'en' } };
  for (const generation of ['en-u-ca-gregory', 'en-x-private', 'de-CH', 'zh-Hant-TW']) {
    assert.equal(decodeConversation(JSON.parse(JSON.stringify({ ...entry, language: { ui: 'en', generation } })))?.language?.generation, generation);
  }
  for (const generation of ['en-x', 'en-u-a', 'not_a_language']) {
    assert.equal(decodeConversation({ ...entry, language: { ui: 'en', generation } }), null);
  }
});

test('#7053 a floating Assistant keeps Back to Clash when the native sidebar is collapsed', () => {
  useViewerStore.setState({ sidebarActivePanel: 'clash', sidebarMode: 'expanded', rightPanelCollapsed: false,
    isMobile: false, floatingPanels: [], poppedOutIds: [] });
  useAssistantPlacement.setState({ placement: 'floating', returnTarget: 'clash' });
  replaceEvidence(captureEvidence('clash'));
  const ui = render(<AssistantPanel />);
  act(() => useViewerStore.getState().setSidebarMode('collapsed'));
  const back = [...ui.querySelectorAll('button')].find(button => /Back to Clash/.test(button.textContent ?? ''));
  assert.ok(back, 'the hidden dock source remains reachable');
  click(back);
  assert.equal(useViewerStore.getState().sidebarMode, 'expanded');
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'clash');
});

test('#7053 legacy archived language follows UI locale despite a different new-conversation preference', async () => {
  const { openConversation } = await import('@/lib/assistant/library');
  const { decodeConversation } = await import('@/lib/assistant/persistence');
  setGenerationLanguagePreference('de');
  const now = new Date().toISOString();
  const entry = decodeConversation({ version: 1, id: 'legacy-language', name: 'Legacy record', savedAt: now, model: 'recorded-model',
    evidence: { source: 'clash', capturedAt: now, payload: JSON.stringify({ source: 'clash', capturedAt: now, totalRows: 0, includedRows: 0, projectionTruncated: false, rows: [] }),
      totalRows: 0, includedRows: 0, projectionTruncated: false }, messages: [] });
  assert.ok(entry);
  openConversation(entry);
  const ui = render(<AssistantPanel />);
  assert.equal(ui.querySelector<HTMLSelectElement>('#assistant-generation-language')?.value, 'en');
  assert.deepEqual(useAssistant.getState().language, { ui: 'en', generation: 'en' });
  assert.equal(useGenerationLanguagePreference.getState().language, 'de', 'the new-conversation preference remains independent');
});
