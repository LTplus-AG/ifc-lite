/* SPDX-License-Identifier: MPL-2.0 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewReasoning } from './review-reasoning.mjs';
import { requestOpenRouterReviewWithUsage } from '../openrouter-reviewer.mjs';

test('cheap profile uses supported settings and preserves high reasoning for strong seats', () => {
  assert.deepEqual(reviewReasoning('openai/gpt-6-luna', 'cheap-defaults'), { effort: 'medium' });
  assert.deepEqual(reviewReasoning('google/gemini-3.5-flash-lite', 'cheap-defaults'), { effort: 'minimal' });
  assert.deepEqual(reviewReasoning('deepseek/deepseek-v4-flash', 'cheap-defaults'), { enabled: false });
  assert.deepEqual(reviewReasoning('openai/gpt-6.1-sol', 'cheap-defaults'), { effort: 'high' });
  assert.deepEqual(reviewReasoning('anthropic/claude-opus-5.5', 'cheap-defaults'), { effort: 'high' });
  assert.deepEqual(reviewReasoning('openai/gpt-6-luna'), { effort: 'high' });
  assert.throws(() => reviewReasoning('openai/gpt-6-luna', 'low'), /Unknown review reasoning profile/);
});

test('the request carries disabled reasoning without an incompatible effort field', async () => {
  let sent;
  await requestOpenRouterReviewWithUsage({ prompt: 'p', apiKey: 'k', model: 'deepseek/deepseek-v4-flash', reasoning: reviewReasoning('deepseek/deepseek-v4-flash', 'cheap-defaults'),
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'answer' } }] }) };
    },
  });
  assert.deepEqual(sent.reasoning, { enabled: false });
  assert.equal(sent.max_tokens, 32768);
});
