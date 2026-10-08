/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7132: MCP uses the same configured schema protocol and root budget as the CLI. */
import { afterEach, expect, it, vi } from 'vitest';
import { createRootBudget } from '@ifc-lite/ai';
import { mcpFlowAi } from './flow-ai.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each(['true', 'false'])('forwards native schemas according to host support and records the actual protocol: %s', async setting => {
  vi.stubEnv('IFC_LITE_AI_MODEL', 'configured-model');
  vi.stubEnv('IFC_LITE_AI_API_KEY', 'test-only');
  vi.stubEnv('IFC_LITE_AI_BASE_URL', 'https://example.invalid/v1');
  vi.stubEnv('IFC_LITE_AI_STRUCTURED_OUTPUT', setting);
  const sent: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"sections":[]}' }, finish_reason: 'stop' }] }));
  });
  const receipts: unknown[] = [];
  const budget = createRootBudget({ maxRequests: 1, maxOutputTokens: 100 });
  let starts = 0;
  const ai = mcpFlowAi(budget, receipts, () => { starts++; });
  if (!ai) throw new Error('Configured MCP AI service must be available');
  const call = { system: 'Native summary', prompt: 'Captured evidence', maxOutputTokens: 25,
    outputSchema: { name: 'flow_summary', schema: { type: 'object', properties: { sections: { type: 'array', items: { type: 'string' } } },
      required: ['sections'], additionalProperties: false } } };
  expect((await ai.request(call)).kind).toBe('completed');
  expect((await ai.request(call)).kind).toBe('refused');
  expect(sent).toHaveLength(1);
  expect(starts).toBe(1);
  expect(budget.requests).toBe(1);
  expect(sent[0].response_format).toEqual(setting === 'true'
    ? { type: 'json_schema', json_schema: { ...call.outputSchema, strict: true } } : undefined);
  expect(receipts).toMatchObject([{ route: 'mcp', outputFormat: setting === 'true' ? 'json-schema' : 'text' }]);
});
