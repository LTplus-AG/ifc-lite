/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture';
import { afterEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { IfcTypeEnum } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { BimReactContext } from '@/sdk/BimProvider';
import { LocalBackend } from '@/sdk/local-backend';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import type { ExtensionHostService } from '@/services/extensions/host';
import { revisionPair } from '@/lib/compare/revision-pair.test-support';
import { updateApiKeys, clearApiKeys } from '@/services/api-keys';
import { useRequestReceipts } from '@/lib/llm/request-receipts';
import { ASSISTANT_ROOT_BUDGET } from '@/lib/llm/root-budget';
import { render, cleanup, click, type, waitFor } from '@/test/render';
import { ChatPanel } from './ChatPanel';

const initial = useViewerStore.getState();
const originalFetch = globalThis.fetch;
// Unrelated Extensions chrome needs a host; transport, native script application and IFC queries are real.
const chromeHost = { emitAction: () => {}, flavors: { getActive: async () => null } } as unknown as ExtensionHostService;
afterEach(() => {
  cleanup();
  act(() => { useViewerStore.getState().clearChatMessages(); useViewerStore.setState(initial, true); clearApiKeys(); });
  useRequestReceipts.setState({ receipts: [], inFlight: [] });
  globalThis.fetch = originalFetch;
});
const data = (events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
const code = "console.log('7093 native walls', bim.query.byType('IfcWall').length);";
const reply = `\`\`\`js\n${code}\n\`\`\``;
const chatFrames = (text: string, reason = 'stop', usage = true) => data([
  { choices: [{ delta: { content: text }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: reason }], ...(usage ? { usage: { prompt_tokens: 25, completion_tokens: 1, total_tokens: 26 } } : {}) },
]) + 'data: [DONE]\n\n';
async function mountNative(t: TestContext, model = 'openai/gpt-free') {
  const pair = await revisionPair(t); if (!pair) return null;
  act(() => {
    useViewerStore.getState().clearChatMessages();
    useViewerStore.setState({ models: new Map([['B', pair.head]]), activeModelId: 'B', ifcDataStore: pair.head.ifcDataStore,
      chatActiveModel: model, chatAutoExecute: true, scriptLastResult: null, scriptLastError: null, scriptLastDiagnostics: [], scriptEditorContent: '', scriptEditorRevision: 0 });
    if (model === 'openai/gpt-free') clearApiKeys();
    else updateApiKeys({ openaiKey: 'sk-test-7093', anthropicKey: 'sk-ant-test-7093' });
  });
  const bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
  const ui = render(<BimReactContext.Provider value={bim}><ExtensionHostContext.Provider value={chromeHost}><ChatPanel /></ExtensionHostContext.Provider></BimReactContext.Provider>);
  return { ui, pair, bim };
}
function send(ui: HTMLElement, prompt = 'Count the walls using a script') {
  const input = ui.querySelector<HTMLTextAreaElement>('textarea[aria-label="Chat message"]'); assert.ok(input);
  type(input, prompt);
  const button = ui.querySelector('button[aria-label="Send (Enter)"]'); assert.ok(button); click(button);
}
function serve(frames: string, status = 200) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input, init) => {
    if (init?.method !== 'POST') return new Response('{}', { status: 200 });
    sent.push({ url: String(input), body: JSON.parse(String(init.body)) });
    return new Response(frames, { status, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  return sent;
}
for (const provider of ['proxy', 'openai', 'anthropic'] as const) test(`#7093 mounted scripting ${provider} uses shared receipts and executes a real native IFC query`, async t => {
  const frames = provider === 'anthropic' ? [
    { type: 'message_start', message: { id: 'msg-7093', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') : chatFrames(reply);
  const sent = serve(frames);
  const native = await mountNative(t, provider === 'proxy' ? 'openai/gpt-free' : provider === 'openai' ? 'gpt-6.1-sol' : 'claude-opus-5-5'); if (!native) return;
  send(native.ui);
  await waitFor(() => useViewerStore.getState().scriptLastResult !== null || useViewerStore.getState().scriptLastError !== null || useViewerStore.getState().chatError !== null, 'native sandbox completed query', 15_000).catch(error => { throw new Error(String(error) + JSON.stringify({ sent: sent.length, receipts: useRequestReceipts.getState().receipts, status: useViewerStore.getState().chatStatus, chatError: useViewerStore.getState().chatError, scriptError: useViewerStore.getState().scriptLastError })); });
  assert.equal(sent.length, 1);
  const [receipt] = useRequestReceipts.getState().receipts; assert.ok(receipt);
  assert.equal(receipt.route, provider); assert.equal(receipt.outcome, 'completed');
  assert.ok(receipt.usageReported); assert.equal(receipt.outputTokens, 1);
  const result = useViewerStore.getState().scriptLastResult; assert.ok(result);
  const expected = native.pair.head.ifcDataStore.entities.getByType(IfcTypeEnum.IfcWall).length;
  assert.ok(expected > 0);
  assert.ok(result.logs.some(log => log.args[0] === '7093 native walls' && log.args[1] === expected), 'QuickJS calls the real model-backed query adapter');
  assert.equal(useRequestReceipts.getState().inFlight.length, 0);
});

test('#7093 truncated code never executes or installs; Continue retains its root across panel remount and exhaustion sends no extra HTTP', async t => {
  const sent = serve(chatFrames(reply, 'length'));
  let native = await mountNative(t); if (!native) return;
  send(native.ui);
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
    const text = posts === maxRequests ? `\`\`\`js\n${bad}\n\`\`\`` : posts > maxRequests ? reply : 'Partial response';
    return new Response(chatFrames(text, posts < maxRequests ? 'length' : 'stop'), { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  const native = await mountNative(t); if (!native) return;
  send(native.ui);
  for (let count = 1; count < maxRequests; count++) {
    await waitFor(() => useRequestReceipts.getState().receipts.length === count && !['sending', 'streaming'].includes(useViewerStore.getState().chatStatus), 'truncated task request');
    const button = [...native.ui.querySelectorAll('button')].find(button => button.textContent === 'Continue'); assert.ok(button); click(button);
  }
  await waitFor(() => useViewerStore.getState().chatError?.includes('budget exhausted') === true, 'native preflight repair refuses exhausted root');
  assert.equal(posts, maxRequests);
  assert.match(useViewerStore.getState().scriptLastError ?? '', /^Preflight validation failed:/);
  assert.ok(useViewerStore.getState().scriptLastDiagnostics.length > 0, 'the repair originates in real native diagnostics');
  assert.equal(useRequestReceipts.getState().receipts.length, maxRequests);
  send(native.ui, 'Count the walls again');
  await waitFor(() => useViewerStore.getState().scriptLastResult !== null, 'explicit new task executes native query');
  assert.equal(posts, maxRequests + 1);
});
