/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { useRequestReceipts } from '@/lib/llm/request-receipts';
import { waitFor } from '@/test/render';
import { act } from 'react';
import { BimReactContext } from '@/sdk/BimProvider';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { render, cleanup, click } from '@/test/render';
import { ASSISTANT_ROOT_BUDGET } from '@/lib/llm/root-budget';
import { ChatPanel } from './ChatPanel';
import { chromeHost, code, data, reply, chatFrames, serve, serveGated, mountNative, send } from '@/test/script-chat-fixture';

test('#7093 truncated code never executes or installs; Continue retains its root across panel remount and exhaustion sends no extra HTTP', async t => {
  const { sent, release } = serveGated(chatFrames(reply, 'length'));
  let native = await mountNative(t); if (!native) return;
  send(native.ui);
  await waitFor(() => sent.length === 1 && useRequestReceipts.getState().inFlight.length === 1, 'truncated task exposes native running request before script bytes');
  await act(async () => release());
  await waitFor(() => useRequestReceipts.getState().receipts.length === 1 && !['sending', 'streaming'].includes(useViewerStore.getState().chatStatus), 'typed truncation');
  assert.equal(useViewerStore.getState().scriptLastResult, null);
  assert.equal(useViewerStore.getState().scriptEditorContent, '');
  assert.equal(useViewerStore.getState().chatToolReady, null);
  const maxRequests = ASSISTANT_ROOT_BUDGET.maxRequests;
  // Remount only the native host, preserving the actual conversation and task.
  cleanup();
  const ui = render(<BimReactContext.Provider value={native.bim}><ExtensionHostContext.Provider value={chromeHost}><ChatPanel /></ExtensionHostContext.Provider></BimReactContext.Provider>);
  // lastFinishReason was local UI state; a saved truncated turn must still offer Continue.
  const continueButton = () => [...ui.querySelectorAll('button')].find(button => button.textContent === 'Continue');
  assert.ok(continueButton(), 'native truncated receipt remains resumable after remount');
  for (let index = 1; index < maxRequests; index++) {
    const button = continueButton(); assert.ok(button); click(button);
    await waitFor(() => useRequestReceipts.getState().receipts.length === index + 1 && !['sending', 'streaming'].includes(useViewerStore.getState().chatStatus), 'continued bounded request');
  }
  const button = continueButton(); assert.ok(button); click(button);
  await waitFor(() => useViewerStore.getState().chatError?.includes('budget exhausted') === true, 'typed no-dispatch refusal');
  assert.equal(sent.length, maxRequests);
  assert.equal(useRequestReceipts.getState().receipts.length, sent.length);
  assert.equal(useViewerStore.getState().scriptLastResult, null);
});

for (const kind of ['empty', 'http-error'] as const) test(`#7093 mounted ${kind} response records shared failure without script side effects`, async t => {
  const sent = serve(kind === 'empty' ? chatFrames(' ') : JSON.stringify({ error: '7093 native provider unavailable' }), kind === 'empty' ? 200 : 503);
  const native = await mountNative(t); if (!native) return;
  send(native.ui);
  await waitFor(() => useRequestReceipts.getState().receipts.length === 1 && !['sending', 'streaming'].includes(useViewerStore.getState().chatStatus), 'typed failure');
  assert.equal(sent.length, 1); assert.equal(useRequestReceipts.getState().receipts[0].outcome, 'error');
  assert.equal(useViewerStore.getState().scriptEditorContent, ''); assert.equal(useViewerStore.getState().scriptLastResult, null);
  assert.ok(useViewerStore.getState().chatError);
});

for (const ending of ['stop', 'timeout'] as const) test(`#7093 ${ending} cancels real streaming edits without executing or retaining a partial native mutation`, async t => {
  let posts = 0;
  const edits = `\`\`\`ifc-script-edits\n${JSON.stringify({ scriptEdits: [{ opId: '7093-partial', type: 'append', baseRevision: 0, text: code }] })}\n\`\`\``;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method !== 'POST') return new Response('{}');
    posts++;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(data([{ choices: [{ delta: { content: edits }, finish_reason: null }] }])));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  const native = await mountNative(t); if (!native) return;
  if (ending === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    send(native.ui);
    if (ending === 'timeout') {
      // Drain native preparation and stream microtasks without advancing the deadline.
      await act(async () => { for (let index = 0; index < 100; index++) await Promise.resolve(); });
    } else await waitFor(() => useViewerStore.getState().scriptEditorContent === code, 'real incremental native edit');
    assert.equal(useViewerStore.getState().scriptEditorContent, code);
    assert.equal(useViewerStore.getState().scriptLastResult, null);
    if (ending === 'timeout') {
      await act(async () => { t.mock.timers.tick(120_000); });
      t.mock.timers.reset();
    } else {
      const stop = native.ui.querySelector('button[aria-label="Stop generating"]'); assert.ok(stop); click(stop);
      assert.equal(useViewerStore.getState().scriptEditorContent, '', 'Stop rolls back before a new task can supersede it');
    }
    await waitFor(() => useRequestReceipts.getState().receipts.length === 1, 'terminal shared receipt');
    const [receipt] = useRequestReceipts.getState().receipts;
    assert.equal(receipt.outcome, ending === 'stop' ? 'cancelled' : 'timeout');
    assert.equal(receipt.usageReported, false); assert.equal('outputTokens' in receipt, false);
    assert.equal(posts, 1); assert.equal(useRequestReceipts.getState().inFlight.length, 0);
    assert.equal(useViewerStore.getState().scriptEditorContent, '');
    assert.equal(useViewerStore.getState().scriptLastResult, null);
    assert.equal(useViewerStore.getState().chatToolReady, null);
  } finally { if (ending === 'timeout') t.mock.timers.reset(); }
});

test('#7093 native preflight automatic repair shares the exhausted Continue task and an explicit new prompt gets a new root', async t => {
  const maxRequests = ASSISTANT_ROOT_BUDGET.maxRequests;
  let posts = 0;
  const bad = 'bim.query.nonexistent7093();';
  globalThis.fetch = (async (_input, init) => {
    if (init?.method !== 'POST') return new Response('{}');
    posts++;
    const text = posts === maxRequests ? `\`\`\`js\n${bad}\n\`\`\`` : posts > maxRequests ? 'New task ready' : 'Partial response';
    return new Response(chatFrames(text, posts < maxRequests ? 'length' : 'stop'), { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  const native = await mountNative(t); if (!native) return;
  send(native.ui);
  for (let count = 1; count < maxRequests; count++) {
    await waitFor(() => useRequestReceipts.getState().receipts.length === count && !['sending', 'streaming'].includes(useViewerStore.getState().chatStatus), 'truncated task request');
    const button: HTMLButtonElement | undefined = [...native.ui.querySelectorAll('button')].find(candidate => candidate.textContent === 'Continue'); assert.ok(button); click(button);
  }
  await waitFor(() => useViewerStore.getState().chatError?.includes('budget exhausted') === true, 'native preflight repair refuses exhausted root');
  assert.equal(posts, maxRequests);
  assert.match(useViewerStore.getState().scriptLastError ?? '', /^Preflight validation failed:/);
  assert.ok(useViewerStore.getState().scriptLastDiagnostics.length > 0, 'the repair originates in real native diagnostics');
  assert.equal(useRequestReceipts.getState().receipts.length, maxRequests);
  send(native.ui, 'Count the walls again');
  await waitFor(() => useRequestReceipts.getState().receipts.length === maxRequests + 1 && !['sending', 'streaming'].includes(useViewerStore.getState().chatStatus), 'explicit new task completes');
  assert.equal(useRequestReceipts.getState().receipts.at(-1)?.outcome, 'completed');
  assert.equal(useViewerStore.getState().chatMessages.at(-1)?.content, 'New task ready');
  assert.equal(posts, maxRequests + 1);
});
