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
import { IfcTypeEnum } from '@ifc-lite/data';
import { reply, chatFrames, serveGated, mountNative, send } from '@/test/script-chat-fixture';

for (const provider of ['proxy', 'openai', 'anthropic'] as const) test(`#7093 mounted scripting ${provider} uses shared receipts and executes a real native IFC query`, async t => {
  const frames = provider === 'anthropic' ? [
    { type: 'message_start', message: { id: 'msg-7093', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') : chatFrames(reply);
  const { sent, release } = serveGated(frames);
  const native = await mountNative(t, provider === 'proxy' ? 'openai/gpt-free' : provider === 'openai' ? 'gpt-6.1-sol' : 'claude-opus-5-5'); if (!native) return;
  send(native.ui);
  await waitFor(() => sent.length === 1 && useRequestReceipts.getState().inFlight.length === 1, 'shared request exposes cancellable native activity before response bytes');
  assert.equal(useViewerStore.getState().scriptLastResult, null);
  await act(async () => release());
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
