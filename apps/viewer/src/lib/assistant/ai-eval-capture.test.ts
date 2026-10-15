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
import { clearApiKeys, getApiKeys, updateApiKeys } from '@/services/api-keys';
import { captureRequest } from '@/test/ai-eval-capture';
import { sendsSamplingParams } from '@/lib/llm/models';

const task = { id: 'clash-summary', scene: 'clash-rev-b', prompt: 'Summarize the most severe clashes and where they occur' };
const comparable = (system: string) => system.replace(/"capturedAt":"[^"]+"/g, '');

test('#6928 proxy, Anthropic and both OpenAI APIs capture one route-neutral request', async () => {
  const captured = [];
  for (const model of ['eval/proxy-model', 'claude-sonnet-5-5', 'gpt-6-luna', 'gpt-5.3-codex']) {
    const result = await captureRequest(task, model);
    assert.ok('request' in result, `${model}: ${'skipped' in result ? result.skipped : ''}`);
    captured.push(result.request);
  }
  const [proxy, ...direct] = captured;
  assert.equal(typeof proxy.maxOutputTokens, 'number');
  assert.match(proxy.system, /Frozen native evidence/);
  for (const request of direct) {
    assert.equal(comparable(request.system), comparable(proxy.system));
    assert.deepEqual(request.messages, proxy.messages, 'the OpenAI system or developer entry is not left in the conversation');
    assert.equal(request.maxOutputTokens, proxy.maxOutputTokens);
  }
  // Sequential: each capture swaps the global fetch and the stored keys.
  const accepts: Record<string, boolean> = {};
  for (const model of ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001']) {
    const result = await captureRequest(task, model);
    assert.ok('request' in result, `${model} was captured`);
    accepts[model] = result.request.sentTemperature;
  }
  assert.deepEqual(accepts, Object.fromEntries(Object.keys(accepts).map(model => [model, sendsSamplingParams(model)])), 'temperature follows the viewer model flag');
  assert.deepEqual(new Set(Object.values(accepts)), new Set([true, false]), 'both branches are exercised');
  const { anthropicKey, openaiKey } = getApiKeys();
  assert.deepEqual([anthropicKey, openaiKey], ['', ''], 'the capture placeholder is not left stored');
});

test('#6928 capture restores keys that were stored before it ran', async () => {
  const stored = { anthropicKey: 'own-key', anthropicWorkspaceId: 'own-workspace', openaiKey: '' };
  updateApiKeys(stored);
  try {
    await captureRequest(task, 'claude-sonnet-5-5');
    assert.deepEqual(getApiKeys(), stored);
  } finally { clearApiKeys(); }
});
