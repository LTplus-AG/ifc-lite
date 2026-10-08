/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { render, click, type, cleanup, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { AssistantPanel } from './AssistantPanel';
import { useAssistant, cancelAssistant, replaceEvidence } from '@/lib/assistant/conversation';
import { captureEvidence } from '@/lib/assistant/evidence';
import { createRootBudget } from '@/lib/llm/root-budget';
import { FREE_MODELS } from '@/lib/llm/models';
import { useRequestReceipts } from '@/lib/llm/request-receipts';

const initial = useViewerStore.getState();
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup(); cancelAssistant(); globalThis.fetch = originalFetch; mock.restoreAll();
  useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle', budget: createRootBudget() });
  useRequestReceipts.setState({ receipts: [] });
});

const freeModel = FREE_MODELS[0]?.id;
const skipFree = freeModel ? false : 'no free proxy model configured (set VITE_LLM_FREE_MODELS, as CI does)';
const sse = (events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const button = (root: HTMLElement, label: string) => [...root.querySelectorAll('button')].find(b => b.textContent?.trim() === label);

function attachClash(budget = createRootBudget()) {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('m')), chatActiveModel: freeModel });
  replaceEvidence(captureEvidence('clash'));
  useAssistant.setState({ budget });
}

// P02 (#6812): a repair follow-up draws on the same root budget as the answer it repairs.
test('usage footer, free quota refresh and root-budget refusal of a repair follow-up', { skip: skipFree }, async () => {
  let chatPosts = 0;
  let quotaGets = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'GET') {
      quotaGets++;
      return new Response(JSON.stringify({ usage: { type: 'requests', used: 4 + quotaGets, limit: 50, pct: 10, resetAt: 1_700_000_000 } }));
    }
    chatPosts++;
    return sse([
      { choices: [{ delta: { content: '{"version":1,"kind":"clash.groups","groups":[]}' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 1234, completion_tokens: 456 } },
    ]);
  }) as typeof fetch;
  attachClash(createRootBudget({ maxRequests: 1, maxOutputTokens: 4096 }));
  const ui = render(<AssistantPanel />);
  await waitFor(() => /Free requests left: 45 of 50/.test(ui.textContent ?? ''), 'quota fetched when the panel opens');

  type(ui.querySelector('textarea')!, 'Group these clashes');
  click(button(ui, 'Send')!);
  await waitFor(() => useAssistant.getState().messages.length === 2, 'first answer completes');
  assert.match(ui.textContent ?? '', /1,234 → 456 tokens · [\d.]+ s/, 'the answer shows its provider-reported usage');
  await waitFor(() => /Free requests left: 44 of 50/.test(ui.textContent ?? ''), 'quota refreshed after the completed request');

  click(button(ui, 'Ask for a corrected proposal')!);
  assert.match(ui.querySelector('textarea')!.value, /could not be previewed/);
  click(button(ui, 'Send')!);
  await waitFor(() => useAssistant.getState().error === 'budget-exhausted', 'repair refused by the root budget');
  assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /used its request budget/);
  assert.equal(chatPosts, 1, 'the refused repair never reached the provider');
  assert.equal(useAssistant.getState().messages.length, 2);

  click(ui.querySelector('button[aria-label="Refresh evidence and start a new conversation"]')!);
  assert.equal(useAssistant.getState().budget.requests, 0, 'Refresh starts a new root budget');
});

test('a failed quota check is shown as unknown and logged, never hidden', { skip: skipFree }, async () => {
  const warn = mock.method(console, 'warn', () => undefined);
  globalThis.fetch = (async () => new Response('{"error":"Usage service failed"}', { status: 502 })) as typeof fetch;
  attachClash();
  const ui = render(<AssistantPanel />);
  await waitFor(() => /Free requests left: unknown/.test(ui.textContent ?? ''), 'unknown quota is visible');
  assert.ok(warn.mock.calls.some(call => String(call.arguments[0]).includes('HTTP 502')));
});

test('an answer without provider usage says so instead of estimating', async () => {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'GET'
    ? new Response(JSON.stringify({ usage: { type: 'requests', used: 1, limit: 50, pct: 2, resetAt: 0 } }))
    : sse([{ choices: [{ delta: { content: 'Plain answer' }, finish_reason: 'stop' }] }])) as typeof fetch;
  attachClash();
  useViewerStore.setState({ chatActiveModel: freeModel ?? 'vendor/unlisted-proxy-model' });
  const ui = render(<AssistantPanel />);
  type(ui.querySelector('textarea')!, 'Explain');
  click(button(ui, 'Send')!);
  await waitFor(() => useAssistant.getState().messages.length === 2, 'answer completes');
  assert.match(ui.textContent ?? '', /Usage not reported · [\d.]+ s/);
  assert.doesNotMatch(ui.textContent ?? '', /tokens ·/);
});
