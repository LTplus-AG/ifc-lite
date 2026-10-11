/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7132: real transport wire contracts and budget/receipt behavior at an HTTP boundary. */
import { expect, it } from 'vitest';
import { createRootBudget } from './budget.js';
import { runModelRequest } from './request.js';
import { chatCompletionsTransport, flowAiConfig } from './chat-completions.js';

const outputSchema = { name: 'classification', schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } },
  required: ['items'], additionalProperties: false } };
const config = { model: 'configured-model', apiKey: 'never-record', baseUrl: 'https://example.invalid/v1' };

it.each([true, false])('sends a strict schema only for a configured compatible upstream: %s', async structuredOutput => {
  const bodies: Record<string, unknown>[] = [];
  const transport = chatCompletionsTransport({ ...config, structuredOutput }, async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":["a"]}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 4 } }));
  });
  const budget = createRootBudget({ maxRequests: 1, maxOutputTokens: 100 });
  const result = await runModelRequest({ model: config.model, route: 'headless', transport, messages: ['Source'],
    budget, maxOutputTokens: 50, routeCeiling: 25, timeoutMs: 1000, outputSchema });
  expect(result.kind).toBe('completed');
  expect(bodies).toHaveLength(1);
  expect(bodies[0].max_tokens).toBe(25);
  expect(bodies[0].response_format).toEqual(structuredOutput
    ? { type: 'json_schema', json_schema: { ...outputSchema, strict: true } } : undefined);
  expect(budget).toMatchObject({ requests: 1, outputTokens: 4 });
  if (result.kind !== 'completed') throw new Error('Expected completed request');
  expect(result.receipt).toMatchObject({ outputFormat: structuredOutput ? 'json-schema' : 'text', usageReported: true, inputTokens: 12, outputTokens: 4 });
  expect(JSON.stringify(result.receipt)).not.toContain('never-record');
  expect(JSON.stringify(result.receipt)).not.toContain('classification');
});

it('does not retry a rejected schema as text or spend a second request', async () => {
  let calls = 0;
  const transport = chatCompletionsTransport({ ...config, structuredOutput: true }, async () => { calls++; return new Response('Unsupported schema', { status: 400 }); });
  const budget = createRootBudget({ maxRequests: 2, maxOutputTokens: 100 });
  const result = await runModelRequest({ model: config.model, route: 'headless', transport, messages: ['Source'], budget,
    maxOutputTokens: 25, routeCeiling: 25, timeoutMs: 1000, outputSchema });
  expect(result).toMatchObject({ kind: 'error', code: 'request-failed', receipt: { outputFormat: 'json-schema' } });
  expect(calls).toBe(1);
  expect(budget.requests).toBe(1);
});

it('opts in only on the exact official endpoint or an explicit host setting', () => {
  const env = { IFC_LITE_AI_MODEL: 'model', IFC_LITE_AI_API_KEY: 'key' };
  expect(flowAiConfig(env)?.structuredOutput).toBe(false);
  expect(flowAiConfig({ ...env, IFC_LITE_AI_BASE_URL: 'https://api.openai.com/v1/' })?.structuredOutput).toBe(true);
  expect(flowAiConfig({ ...env, IFC_LITE_AI_BASE_URL: 'https://api.openai.com.evil/v1' })?.structuredOutput).toBe(false);
  expect(flowAiConfig({ ...env, IFC_LITE_AI_STRUCTURED_OUTPUT: 'true' })?.structuredOutput).toBe(true);
  expect(() => flowAiConfig({ ...env, IFC_LITE_AI_STRUCTURED_OUTPUT: 'invalid' })).toThrow('must be true or false');
});
