/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live-evaluation request capture (#6928). The runner re-sends what the
 * Assistant would send; a BYOK model must capture the same request as the
 * proxy route, not be refused for a missing key or lose its output ceiling.
 */

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getApiKeys } from '@/services/api-keys';
import { captureRequest } from '@/test/ai-eval-capture';

const task = { id: 'clash-summary', scene: 'clash-rev-b', prompt: 'Summarize the most severe clashes and where they occur' };
const comparable = (system: string) => system.replace(/"capturedAt":"[^"]+"/g, '');

test('#6928 proxy, Anthropic and OpenAI models capture one route-neutral request', async () => {
  const captured = [];
  for (const model of ['eval/proxy-model', 'claude-sonnet-5-5', 'gpt-6-luna']) {
    const result = await captureRequest(task, model);
    assert.ok('request' in result, `${model}: ${'skipped' in result ? result.skipped : ''}`);
    captured.push(result.request);
  }
  const [proxy, ...direct] = captured;
  assert.equal(typeof proxy.maxOutputTokens, 'number');
  assert.match(proxy.system, /Frozen native evidence/);
  for (const request of direct) {
    assert.equal(comparable(request.system), comparable(proxy.system));
    assert.deepEqual(request.messages, proxy.messages, 'the OpenAI system message is not left in the conversation');
    assert.equal(request.maxOutputTokens, proxy.maxOutputTokens);
  }
  assert.deepEqual([getApiKeys().anthropicKey, getApiKeys().openaiKey], ['', ''], 'the capture placeholder is not left stored');
});
