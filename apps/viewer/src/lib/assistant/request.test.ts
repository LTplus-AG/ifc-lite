/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { captureEvidence } from './evidence';
import { useAssistant, replaceEvidence, cancelAssistant } from './conversation';
import { sendAssistant } from './request';
import { UNCONFIGURED_MODEL_ID } from '@/lib/llm/models';

const originalFetch = globalThis.fetch;
const initial = useViewerStore.getState();
afterEach(() => { cancelAssistant(); globalThis.fetch = originalFetch; useViewerStore.setState(initial, true); });
const model = 'openai/gpt-free';

test('an unconfigured native model cannot initiate a request or add conversation history (#6833)', () => {
  replaceEvidence(captureEvidence('loadReport'));
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Missing configuration must refuse before fetch'); };
  return sendAssistant('Explain', UNCONFIGURED_MODEL_ID, '/api/chat').then(completed => {
    assert.equal(completed, false);
    assert.equal(calls, 0);
    assert.equal(useAssistant.getState().messages.length, 0);
    assert.equal(useAssistant.getState().error, 'missing-model');
  });
});

// #6813: exercise real SSE consumption and provider payloads through the shared client.
test('assistant sends frozen evidence once, bounds output and never changes script conversation', async () => {
  replaceEvidence(captureEvidence('clash'));
  const scripts = useViewerStore.getState().chatMessages;
  let calls = 0;
  let payload: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => {
    calls++;
    payload = JSON.parse(String(init?.body));
    return new Response('data: {"choices":[{"delta":{"content":"Explain [E1]"},"finish_reason":"length"}]}\n\n');
  };
  await sendAssistant('Explain the results', model, '/api/chat');
  assert.equal(calls, 1);
  assert.equal(payload.maxOutputTokens, 4096);
  assert.match(JSON.stringify(payload.system), /Frozen native evidence/);
  assert.equal(useAssistant.getState().messages.at(-1)?.content, 'Explain [E1]');
  assert.equal(useAssistant.getState().error, 'truncated-output');
  assert.equal(useAssistant.getState().messages.at(-1)?.model, model, 'completed replies retain the actual request model');
  assert.equal(useViewerStore.getState().chatMessages, scripts);
});

test('replacing context aborts a pending SSE reader and rejects late output', async () => {
  replaceEvidence(captureEvidence('clash'));
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = sendAssistant('Explain', model, '/api/chat');
  await new Promise(resolve => setImmediate(resolve));
  replaceEvidence(captureEvidence('compare'));
  await pending;
  assert.equal(cancelled, true, 'cancel must reach the stream body after fetch resolves');
  assert.equal(useAssistant.getState().snapshot?.source, 'compare');
  assert.equal(useAssistant.getState().messages.length, 0);
});

test('editing the model cancels an active request and rejects another send against that snapshot', async () => {
  replaceEvidence(captureEvidence('clash'));
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(new ReadableStream()); };
  const pending = sendAssistant('Explain', model, '/api/chat');
  await new Promise(resolve => setImmediate(resolve));
  useViewerStore.setState({ mutationVersion: initial.mutationVersion + 1 });
  await pending;
  assert.equal(useAssistant.getState().error, 'stale-evidence');
  await sendAssistant('Again', model, '/api/chat');
  assert.equal(calls, 1);
});

// A failed request is pending input, not a completed conversation turn (#6813).
test('provider errors and cancellation never accumulate failed prompts in history', async () => {
  replaceEvidence(captureEvidence('clash'));
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Provider unavailable' }), { status: 503 });
  for (let i = 0; i < 12; i++) assert.equal(await sendAssistant('Retry', model, '/api/chat'), false);
  assert.equal(useAssistant.getState().messages.length, 0);
  globalThis.fetch = async () => new Response(new ReadableStream());
  const pending = sendAssistant('Cancel this', model, '/api/chat');
  await new Promise(resolve => setImmediate(resolve));
  cancelAssistant();
  assert.equal(await pending, false);
  assert.equal(useAssistant.getState().messages.length, 0);
});

// #6822: authoring metadata is derived locally and never exposes omitted parameter values.
test('Flow requests include bounded native contracts while existing parameter values stay outside the prompt', async () => {
  const { newFlowDocument } = await import('../flow/persistence');
  const doc = { ...newFlowDocument('Prompt contract test'), nodes: [{ id: 'private', type: 'core.string', params: { value: 'SECRET_EXCLUDED_FROZEN_VALUE' } }] };
  useViewerStore.setState({ flowDoc: doc, activeFlowId: doc.id, flowRunning: false });
  replaceEvidence(captureEvidence('flow'));
  let system = '';
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    system = typeof payload.system === 'string' ? payload.system : payload.system.map((block: { text: string }) => block.text).join('\n');
    assert.ok(payload.messages.every((message: object) => !Object.hasOwn(message, 'model')));
    return new Response('data: {"choices":[{"delta":{"content":"Draft remains inert"}}]}\n\n');
  };
  assert.equal(await sendAssistant('Draft a Flow patch', model, '/api/chat'), true);
  assert.match(system, /"kind":"flow.patch"/);
  assert.match(system, /core.string/);
  assert.match(system, /"name":"value","kind":"string"/);
  assert.equal(system.includes('SECRET_EXCLUDED_FROZEN_VALUE'), false);
  assert.ok(system.length < 90_000);
  assert.equal(useViewerStore.getState().flowDoc, doc);
  assert.equal(useViewerStore.getState().flowLastRun, initial.flowLastRun);
});
