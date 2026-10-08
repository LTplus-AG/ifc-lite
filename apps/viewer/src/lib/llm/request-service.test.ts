/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runModelRequest, type ModelRequest, type SendableRoute } from './request-service.js';
import { createRootBudget } from './root-budget.js';
import { useRequestReceipts, RECEIPT_LIMIT, recordReceipt } from './request-receipts.js';
import { modelCapabilities } from './model-capabilities.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; useRequestReceipts.setState({ receipts: [] }); });

type Sent = { url: string; body: Record<string, unknown> };

/** Serve one SSE body per request and record what went out. */
function serve(frames: string, init: ResponseInit = { status: 200, headers: { 'Content-Type': 'text/event-stream' } }): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, request?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(request?.body ?? '{}')) as Record<string, unknown> });
    return new Response(frames, init);
  }) as typeof fetch;
  return sent;
}

const data = (events: unknown[]) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
const proxy: SendableRoute = { kind: 'proxy', model: 'openai/gpt-free' };
const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  route: proxy, proxyUrl: '/api/chat', messages: [{ role: 'user', content: 'SECRET_PROMPT_TEXT' }],
  maxOutputTokens: 4096, budget: createRootBudget(), timeoutMs: 10_000, ...overrides,
});

test('#7037: a NaN output ceiling refuses before sending and leaves the budget usable', async () => {
  const sent = serve(data([{ choices: [{ delta: { content: 'Ok' }, finish_reason: 'stop' }] }]));
  const budget = createRootBudget({ maxRequests: 1, maxOutputTokens: 100 });
  assert.deepEqual(await runModelRequest(request({ budget, maxOutputTokens: NaN })), { kind: 'refused', reason: 'budget-exhausted' });
  assert.equal(sent.length, 0);
  assert.equal(useRequestReceipts.getState().receipts.length, 0);
  assert.equal((await runModelRequest(request({ budget, maxOutputTokens: 100 }))).kind, 'completed');
  assert.equal(sent.length, 1);
});

// Proxy: OpenRouter's final chunk carries `usage`; the proxy forwards it and appends its quota event.
test('proxy stream: forwarded OpenRouter usage chunk becomes a reported receipt', async () => {
  serve(data([
    { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
    { choices: [{ delta: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1234, completion_tokens: 456, total_tokens: 1690 } },
    { __ifcLiteUsage: { type: 'requests', used: 6, limit: 50, pct: 12, resetAt: 1_700_000_000 } },
  ]) + 'data: [DONE]\n\n');
  const quota: Array<{ used: number; type: string }> = [];
  const outcome = await runModelRequest(request({ onUsageInfo: info => quota.push(info) }));
  assert.equal(outcome.kind, 'completed');
  assert.deepEqual(quota.map(info => [info.type, info.used]), [['requests', 6]], 'hosted quota remains separate from provider tokens');
  assert.ok(outcome.kind === 'completed');
  assert.equal(outcome.text, 'Hello');
  assert.deepEqual({ ...outcome.receipt, id: '', startedAt: 0, finishedAt: 0 }, {
    id: '', startedAt: 0, finishedAt: 0, model: 'openai/gpt-free', route: 'proxy', outcome: 'completed',
    usageReported: true, inputTokens: 1234, outputTokens: 456,
  });
  assert.equal(useRequestReceipts.getState().receipts.length, 1);
  assert.equal(JSON.stringify(useRequestReceipts.getState().receipts).includes('SECRET_PROMPT_TEXT'), false, 'receipts never hold prompts');
  assert.equal(JSON.stringify(useRequestReceipts.getState().receipts).includes('Hello'), false, 'receipts never hold replies');
});

test('proxy stream without a usage chunk records usageReported: false, never an estimate', async () => {
  serve(data([{ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] }]));
  const outcome = await runModelRequest(request());
  assert.ok(outcome.kind === 'completed');
  assert.equal(outcome.receipt.usageReported, false);
  assert.equal('inputTokens' in outcome.receipt, false);
  assert.equal('outputTokens' in outcome.receipt, false);
});

test('OpenAI Chat Completions: requests include_usage and reads the trailing choices:[] usage chunk', async () => {
  const sent = serve(data([
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Ok' }, finish_reason: null }] },
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, prompt_tokens_details: { cached_tokens: 0 } } },
  ]) + 'data: [DONE]\n\n');
  const outcome = await runModelRequest(request({ route: { kind: 'openai', model: 'gpt-6-sol', apiKey: 'sk-test' } }));
  assert.deepEqual(sent[0]?.body.stream_options, { include_usage: true });
  assert.ok(outcome.kind === 'completed');
  assert.equal(outcome.receipt.route, 'openai');
  assert.ok(outcome.receipt.usageReported);
  assert.equal(outcome.receipt.inputTokens, 300);
  assert.equal(outcome.receipt.outputTokens, 20);
});

test('OpenAI Responses: usage comes from response.completed', async () => {
  serve(data([
    { type: 'response.output_text.delta', delta: 'Codex' },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 77, output_tokens: 9, total_tokens: 86 } } },
  ]));
  const outcome = await runModelRequest(request({ route: { kind: 'openai', model: 'gpt-5.3-codex', apiKey: 'sk-test' } }));
  assert.ok(outcome.kind === 'completed');
  assert.ok(outcome.receipt.usageReported);
  assert.deepEqual([outcome.receipt.inputTokens, outcome.receipt.outputTokens], [77, 9]);
});

const typedSchema = { name: 'flow_summary', schema: { type: 'object', properties: { sections: { type: 'array', items: { type: 'string' } } },
  required: ['sections'], additionalProperties: false } };

test('#7132 OpenAI chat sends a strict schema and records the request format', async () => {
  const sent = serve(data([{ choices: [{ delta: { content: '{"sections":[]}' }, finish_reason: 'stop' }] }]));
  const outcome = await runModelRequest(request({ route: { kind: 'openai', model: 'gpt-6.1-sol', apiKey: 'sk-test' }, outputSchema: typedSchema }));
  assert.deepEqual(sent[0]?.body.response_format, { type: 'json_schema', json_schema: { ...typedSchema, strict: true } });
  assert.ok(outcome.kind === 'completed');
  assert.equal(outcome.receipt.outputFormat, 'json-schema');
});

test('#7132 OpenAI Responses uses text.format rather than the chat-only response_format', async () => {
  const sent = serve(data([{ type: 'response.output_text.delta', delta: '{"sections":[]}' },
    { type: 'response.completed', response: { status: 'completed' } }]));
  const outcome = await runModelRequest(request({ route: { kind: 'openai', model: 'gpt-5.3-codex', apiKey: 'sk-test' }, outputSchema: typedSchema }));
  assert.deepEqual(sent[0]?.body.text, { format: { type: 'json_schema', ...typedSchema, strict: true } });
  assert.equal(sent[0]?.body.response_format, undefined);
  assert.ok(outcome.kind === 'completed');
  assert.equal(outcome.receipt.outputFormat, 'json-schema');
});

test('#7132 unsupported hosted routes remain parser-only and reject no schema by silently resending', async () => {
  const sent = serve(data([{ choices: [{ delta: { content: '{"sections":[]}' }, finish_reason: 'stop' }] }]));
  const outcome = await runModelRequest(request({ outputSchema: typedSchema }));
  assert.ok(outcome.kind === 'completed');
  assert.equal(outcome.receipt.outputFormat, 'text');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.body.response_format, undefined);
  assert.equal(sent[0]?.body.outputSchema, undefined);
});

test('#7132 rejected direct schemas fail the same request without a text fallback', async () => {
  const sent = serve('Unsupported schema', { status: 400 });
  const budget = createRootBudget({ maxRequests: 2, maxOutputTokens: 8192 });
  const outcome = await runModelRequest(request({ route: { kind: 'openai', model: 'gpt-6.1-sol', apiKey: 'sk-test' }, outputSchema: typedSchema, budget }));
  assert.equal(outcome.kind, 'error');
  assert.equal(sent.length, 1);
  assert.equal(budget.requests, 1);
  assert.ok(outcome.kind === 'error');
  assert.equal(outcome.receipt.outputFormat, 'json-schema');
});

test('#7132 Anthropic sends output_config.format through the actual SDK stream', async () => {
  const events = [
    { type: 'message_start', message: { id: 'msg_schema', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"sections":[]}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ];
  const sent = serve(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  const outcome = await runModelRequest(request({ route: { kind: 'anthropic', model: 'claude-opus-5-5',
    credentials: { apiKey: 'sk-ant-test', workspaceId: '' } }, outputSchema: typedSchema }));
  assert.deepEqual(sent[0]?.body.output_config, { format: { type: 'json_schema', schema: typedSchema.schema } });
  assert.equal(sent.length, 1);
  assert.ok(outcome.kind === 'completed');
  assert.equal(outcome.receipt.outputFormat, 'json-schema');
  assert.ok(outcome.receipt.usageReported);
  assert.equal(outcome.receipt.outputTokens, 4);
});

test('Anthropic: message_start + message_delta usage, with cache reads counted as input', async () => {
  const events = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answer' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 15 } },
    { type: 'message_stop' },
  ];
  serve(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  const outcome = await runModelRequest(request({ route: { kind: 'anthropic', model: 'claude-opus-5-5', credentials: { apiKey: 'sk-ant-test', workspaceId: '' } } }));
  assert.ok(outcome.kind === 'truncated', `expected truncated, got ${outcome.kind}`);
  assert.equal(outcome.finishReason, 'max_tokens');
  assert.ok(outcome.receipt.usageReported);
  assert.deepEqual([outcome.receipt.inputTokens, outcome.receipt.outputTokens], [125, 15]);
});

test('outcomes are typed: truncated, empty output and provider error', async () => {
  serve(data([{ choices: [{ delta: { content: 'Partial' }, finish_reason: 'length' }] }]));
  const truncated = await runModelRequest(request());
  assert.equal(truncated.kind, 'truncated');

  serve(data([{ choices: [{ delta: { content: '   ' }, finish_reason: 'stop' }] }]));
  const empty = await runModelRequest(request());
  assert.ok(empty.kind === 'error');
  assert.equal(empty.code, 'empty-output');

  serve(JSON.stringify({ error: 'Provider unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  const failed = await runModelRequest(request());
  assert.ok(failed.kind === 'error');
  assert.equal(failed.code, 'request-failed');
  assert.equal(failed.message, 'Provider unavailable');
  assert.deepEqual(useRequestReceipts.getState().receipts.map(r => r.outcome), ['truncated', 'error', 'error']);
});

test('caller cancellation resolves as cancelled and the deadline resolves as timeout', async () => {
  let cancelledBody = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({ cancel() { cancelledBody = true; } }))) as typeof fetch;
  const controller = new AbortController();
  const pending = runModelRequest(request({ signal: controller.signal }));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.kind, 'cancelled');
  assert.equal(cancelledBody, true, 'cancellation reaches the stream body');

  const timedOut = await runModelRequest(request({ timeoutMs: 20 }));
  assert.equal(timedOut.kind, 'timeout');
  assert.deepEqual(useRequestReceipts.getState().receipts.map(r => r.outcome), ['cancelled', 'timeout']);
});

test('root budget: retries draw on one root, exhaustion refuses before any request', async () => {
  const budget = createRootBudget({ maxRequests: 2, maxOutputTokens: 10_000 });
  const sent = serve(data([
    { choices: [{ delta: { content: 'One' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 100 } },
  ]));
  assert.equal((await runModelRequest(request({ budget }))).kind, 'completed');
  // Reported output is charged exactly: 100 of the 4,096 reservation.
  assert.deepEqual({ requests: budget.requests, outputTokens: budget.outputTokens }, { requests: 1, outputTokens: 100 });
  serve(JSON.stringify({ error: 'Busy' }), { status: 503 });
  assert.equal((await runModelRequest(request({ budget }))).kind, 'error');
  // A request that streamed nothing is charged as a request but no output.
  assert.deepEqual({ requests: budget.requests, outputTokens: budget.outputTokens }, { requests: 2, outputTokens: 100 });
  const refusedSent = serve(data([]));
  const refused = await runModelRequest(request({ budget }));
  assert.deepEqual(refused, { kind: 'refused', reason: 'budget-exhausted' });
  assert.equal(refusedSent.length, 0, 'nothing reaches the network once the root is exhausted');
  assert.equal(sent.length, 1);
  assert.equal(useRequestReceipts.getState().receipts.length, 2, 'a refusal is not a request and has no receipt');
});

test('root budget clamps the last request to the remaining output and charges unreported output in full', async () => {
  const budget = createRootBudget({ maxRequests: 5, maxOutputTokens: 5_000 });
  let sent = serve(data([{ choices: [{ delta: { content: 'A' }, finish_reason: 'stop' }] }]));
  await runModelRequest(request({ budget }));
  assert.equal(sent[0]?.body.maxOutputTokens, 4096);
  assert.equal(budget.outputTokens, 4096, 'unreported usage is charged at the reservation');
  sent = serve(data([{ choices: [{ delta: { content: 'B' }, finish_reason: 'stop' }] }]));
  await runModelRequest(request({ budget }));
  assert.equal(sent[0]?.body.maxOutputTokens, 904);
  assert.equal((await runModelRequest(request({ budget }))).kind, 'refused');
});

test('capabilities come from the registry and route ceilings, with no placeholder window for proxy models', () => {
  assert.deepEqual(modelCapabilities('claude-opus-5-5'), {
    id: 'claude-opus-5-5', route: 'anthropic', tier: 'byok', contextWindow: 1_000_000, maxOutputTokens: 32_000,
    structuredOutput: true, usageReporting: 'provider',
  });
  const unknown = modelCapabilities('vendor/unlisted');
  assert.equal(unknown.route, 'proxy');
  assert.equal(unknown.contextWindow, null);
  assert.equal(unknown.maxOutputTokens, 8192);
  assert.equal(unknown.usageReporting, 'upstream-dependent');
});

test('the receipt store keeps only the most recent receipts', () => {
  for (let i = 0; i < RECEIPT_LIMIT + 5; i++) {
    recordReceipt({ id: `r${i}`, model: 'm', route: 'proxy', startedAt: i, finishedAt: i, outcome: 'completed', usageReported: false });
  }
  const receipts = useRequestReceipts.getState().receipts;
  assert.equal(receipts.length, RECEIPT_LIMIT);
  assert.equal(receipts[0]?.id, 'r5');
});

test('#7093 shared proxy request never adds an unbudgeted development fallback attempt', async () => {
  const previousDev = import.meta.env.DEV;
  import.meta.env.DEV = true;
  try {
    const sent = serve(JSON.stringify({ error: '7093 missing proxy route' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    const budget = createRootBudget();
    const outcome = await runModelRequest(request({ proxyUrl: 'http://localhost:7093/api/chat', budget }));
    assert.equal(outcome.kind, 'error');
    assert.equal(sent.length, 1, 'the explicit transport URL is the only budgeted attempt');
    assert.equal(sent[0].url, 'http://localhost:7093/api/chat');
    assert.equal(budget.requests, 1);
    assert.equal(useRequestReceipts.getState().receipts.length, 1);
  } finally { import.meta.env.DEV = previousDev; }
});


for (const api of ['proxy', 'openai-chat', 'openai-responses', 'anthropic'] as const)
for (const headerDelay of [50_000, 150_000]) test(`#7093 shared deadline covers ${api} headers arriving after ${headerDelay}ms`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let posts = 0;
  let transportSignal: AbortSignal | null | undefined;
  const route: SendableRoute = api === 'proxy' ? proxy : api === 'anthropic'
    ? { kind: 'anthropic', model: 'claude-opus-5-5', credentials: { apiKey: 'sk-ant-test', workspaceId: '' } }
    : { kind: 'openai', model: api === 'openai-chat' ? 'gpt-6-sol' : 'gpt-5.3-codex', apiKey: 'sk-test' };
  const frames = api === 'openai-responses' ? data([
    { type: 'response.output_text.delta', delta: 'Slow response' },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
  ]) : api === 'anthropic' ? [
    { type: 'message_start', message: { id: 'msg_7093', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Slow response' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
    : data([{ choices: [{ delta: { content: 'Slow response' }, finish_reason: 'stop' }] }]);
  globalThis.fetch = async (_input, init) => {
    posts++;
    transportSignal = init?.signal;
    return new Promise<Response>((resolve, reject) => {
      const deliver = setTimeout(() => {
        transportSignal?.removeEventListener('abort', abort);
        resolve(new Response(frames,
          { headers: { 'Content-Type': 'text/event-stream' } }));
      }, headerDelay);
      const abort = () => { clearTimeout(deliver); reject(transportSignal?.reason ?? new Error('Aborted')); };
      transportSignal?.addEventListener('abort', abort, { once: true });
    });
  };
  try {
    const pending = runModelRequest(request({ route, timeoutMs: 120_000 }));
    for (let index = 0; index < 100; index++) await Promise.resolve();
    assert.equal(posts, 1);
    t.mock.timers.tick(45_000);
    for (let index = 0; index < 20; index++) await Promise.resolve();
    assert.equal(transportSignal?.aborted, false, 'the old header timeout cannot preempt the shared deadline');
    assert.equal(useRequestReceipts.getState().inFlight.length, 1);
    assert.equal(useRequestReceipts.getState().receipts.length, 0);
    t.mock.timers.tick(headerDelay === 50_000 ? 5_000 : 75_000);
    const outcome = await pending;
    assert.equal(outcome.kind, headerDelay === 50_000 ? 'completed' : 'timeout');
    assert.equal(useRequestReceipts.getState().receipts[0].outcome, outcome.kind);
    assert.equal(useRequestReceipts.getState().inFlight.length, 0);
    assert.equal(posts, 1);
  } finally { t.mock.timers.reset(); }
});
