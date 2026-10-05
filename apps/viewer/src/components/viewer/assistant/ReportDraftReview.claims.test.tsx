/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, cleanup, type, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { clashDiscussion, typedReport } from '@/test/ai-report-fixture';
import { useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { aiBlockOrigin } from '@/lib/document/ai-report-types';
import { validateDocumentSpec } from '@/lib/document/types';
import { ReportDraftReview } from './ReportDraftReview';

const originalFetch = globalThis.fetch;
const initial = useViewerStore.getState();
afterEach(() => { cleanup(); cancelAssistant(); globalThis.fetch = originalFetch; useViewerStore.setState(initial, true); });

const GERMAN = typedReport('## Zusammenfassung\nDrei harte Kollisionen [E1].', [
  { text: 'E1 überlappt um 20 mm.', facts: [{ citation: 'E1', field: 'distance', value: -20, unit: 'mm' }] },
  { text: 'E2 überlappt um 50 mm.', facts: [{ citation: 'E2', field: 'distance', value: -50, unit: 'mm' }] },
], 'de');

// #6918: the actual review control requests a typed, language-bound draft, shows each claim's check
// and refuses to save while a claim contradicts the captured evidence.
test('requested German draft shows checked claims and a contradicted claim blocks saving until edited', async () => {
  clashDiscussion('Initial discussion answer.');
  let sent: { system?: unknown; messages?: Array<{ content: unknown }> } = {};
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: GERMAN }, finish_reason: 'stop' }] })}\n\n`);
  };
  act(() => useViewerStore.setState({ chatActiveModel: 'openai/gpt-free' }));
  const ui = render(<ReportDraftReview />);
  const button = (text: string) => [...ui.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text)!;
  const language = ui.querySelector<HTMLSelectElement>('#assistant-report-language')!;
  assert.equal(language.labels?.[0]?.textContent, 'Narrative language');
  act(() => { language.value = 'de'; language.dispatchEvent(new window.Event('change', { bubbles: true })); });
  const review = ui.querySelector('details')!;
  act(() => { review.open = true; });
  click(button('Draft report with AI'));
  await waitFor(() => useAssistant.getState().messages.at(-1)?.content === GERMAN, 'provider answer completes');
  assert.ok(review.isConnected && review.open, 'the open review survives the streamed request');
  assert.match(String(sent.messages?.at(-1)?.content), /in German \(de\)/);
  assert.match(JSON.stringify(sent.system), /report\.claims/);
  click(button('Prepare report draft'));
  const claims = ui.querySelector('section[aria-label="Claims checked against captured evidence"]')!;
  assert.deepEqual([...claims.querySelectorAll('[data-claim]')].map(item => item.querySelector('span:nth-child(2)')?.textContent),
    ['Supported by data', 'Contradicted']);
  assert.match(claims.querySelector('[role="alert"]')?.textContent ?? '', /1 claim contradicts the captured evidence/);
  act(() => ui.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  assert.equal(button('Save reviewed document').disabled, true, 'approval alone cannot save a contradicted claim');
  const second = claims.querySelector('[data-claim="C2"]')!;
  click([...second.querySelectorAll('button')].find(candidate => candidate.textContent === 'Edit claim')!);
  const editor = second.querySelector<HTMLTextAreaElement>('textarea')!;
  assert.equal(editor.labels?.[0]?.textContent, 'Claim text');
  type(editor, 'E2 überlappt deutlich.');
  click([...second.querySelectorAll('button')].find(candidate => candidate.textContent === 'Use edited text')!);
  assert.equal(claims.querySelector('[role="alert"]'), null);
  assert.match(claims.querySelector('[data-claim="C2"]')?.textContent ?? '', /Unverifiable.*Edited by you/);
  assert.equal(ui.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, false, 'an edit withdraws approval');
  act(() => ui.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  click(button('Save reviewed document'));
  await waitFor(() => useViewerStore.getState().documents.some(doc => doc.aiReport), 'reviewed report committed');
  const saved = useViewerStore.getState().documents.find(doc => doc.aiReport)!;
  assert.deepEqual(validateDocumentSpec(saved), []);
  assert.equal(saved.aiReport?.language, 'de');
  assert.deepEqual(saved.aiReport?.claims.map(claim => [claim.status, claim.edited]), [['supported', false], ['unverifiable', true]]);
  assert.ok(saved.blocks.some(block => block.kind === 'text' && block.text === 'E2 überlappt deutlich.' && aiBlockOrigin(block) === 'human-edited'),
    'a reviewer rewrite is their text, not AI text');
});

test('an answer declaring another language than the chosen one is flagged in the review', () => {
  clashDiscussion(typedReport('Three hard clashes [E1].', [{ text: 'E1 is hard.', facts: [{ citation: 'E1', field: 'status', value: 'hard' }] }], 'en-GB'));
  const ui = render(<ReportDraftReview />);
  const language = ui.querySelector<HTMLSelectElement>('#assistant-report-language')!;
  act(() => { language.value = 'fr'; language.dispatchEvent(new window.Event('change', { bubbles: true })); });
  click([...ui.querySelectorAll('button')].find(candidate => candidate.textContent === 'Prepare report draft')!);
  assert.equal(ui.querySelector('output')?.textContent,
    'The answer declares its language as en-GB, not the chosen fr. Draft again or choose that language.');
  assert.match(ui.textContent ?? '', /actual-provider · French/);
});
