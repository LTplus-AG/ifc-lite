/* SPDX-License-Identifier: MPL-2.0 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveCost } from './openrouter-eval-reviewer.mjs';
import { requestOpenRouterReviewWithUsage } from './openrouter-reviewer.mjs';

test('evaluation reserves input bytes and maximum completion before spending', () => {
  assert.equal(reserveCost('openai/gpt-6.1-sol', 'abc', 100, 0, 1), (3 * 2 + 100 * 10) / 1e6);
  assert.throws(() => reserveCost('anthropic/claude-opus-5.5', 'abc', 32768, 2.9, 3), /budget exhausted/);
  assert.throws(() => reserveCost('unknown', 'abc', 100, 0, 3), /Known model pricing/);
  for (const budget of [0, -1, NaN, Infinity]) assert.throws(() => reserveCost('openai/gpt-6.1-sol', '', 100, 0, budget), /positive finite/);
});

test('evaluation can bound completion while retaining the production prompt and reasoning effort', async () => {
  let sent;
  await requestOpenRouterReviewWithUsage({ prompt: 'review this', apiKey: 'k', model: 'openai/gpt-6.1-sol', maxTokens: 8192,
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'answer' } }] }) };
    },
  });
  assert.equal(sent.max_tokens, 8192);
  assert.deepEqual(sent.messages, [{ role: 'user', content: 'review this' }]);
  assert.equal(sent.reasoning.effort, 'high');
});
