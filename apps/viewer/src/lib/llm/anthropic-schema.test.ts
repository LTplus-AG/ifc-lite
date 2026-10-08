/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { extractionSchema, proposalSchema } from '../../../../../packages/flow-nodes/src/ai-response-schemas.js';
import { proposalFields } from '../../../../../packages/flow-nodes/src/ai-propose-fields.js';
import { aiExtractNode } from '../../../../../packages/flow-nodes/src/ai-extract.js';
import { parseCapabilities } from '@ifc-lite/extensions';
import { createBimContext } from '@ifc-lite/sdk';
import { IfcTypeEnum } from '@ifc-lite/data';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { runModelRequest, type ModelRequest } from './request-service.js';
import { createRootBudget } from './root-budget.js';
import { useRequestReceipts } from './request-receipts.js';

const originalFetch = globalThis.fetch;
const initial = useViewerStore.getState();
afterEach(() => {
  globalThis.fetch = originalFetch;
  useRequestReceipts.setState({ receipts: [], inFlight: [] });
  useViewerStore.setState(initial, true);
});
const extraction = (count: number) => extractionSchema([0], Array.from({ length: count }, (_, i) => ({ name: `Field${i}`, type: 'string' })));
const proposal = (count: number) => proposalSchema(proposalFields(Array.from({ length: count }, (_, i) => ({
  op: 'property.set', pset: 'Pset_Review', name: `Field${i}`, dataType: 'IfcLabel', expectedColumn: 'Old', allowedValues: ['Reviewed'],
})), ['Old']), ['row'], false);
const request = (outputSchema: ModelRequest['outputSchema']): ModelRequest => ({
  route: { kind: 'anthropic', model: 'claude-opus-5-5', credentials: { apiKey: 'sk-ant-test', workspaceId: '' } },
  proxyUrl: '/api/chat', messages: [{ role: 'user', content: 'Captured evidence' }], outputSchema,
  budget: createRootBudget(), maxOutputTokens: 100, timeoutMs: 1000,
});

for (const [label, schema] of [['17 native extraction fields', extraction(17)], ['7 native proposal bindings', proposal(7)]] as const) {
  test(`#7132 refuses ${label} before dispatch, receipts or root budget reservation`, async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; throw new Error('Unsupported schemas must never dispatch'); };
    const call = request(schema);
    const outcome = await runModelRequest(call);
    assert.ok(outcome.kind === 'refused' && outcome.reason === 'unsupported-schema');
    assert.match(outcome.message, /at most 16 union parameters/);
    assert.equal(requests, 0);
    assert.equal(call.budget.requests, 0);
    assert.equal(call.budget.outputTokens, 0);
    assert.deepEqual(useRequestReceipts.getState(), { receipts: [], inFlight: [] });
  });
}

for (const [label, schema] of [['16 native extraction fields', extraction(16)], ['6 native proposal bindings', proposal(6)]] as const) {
  test(`#7132 preserves ${label} through the actual Anthropic SDK request`, async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const events = [
        { type: 'message_start', message: { id: 'schema_limit', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"records":[]}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const call = request(schema);
    const outcome = await runModelRequest(call);
    assert.ok(outcome.kind === 'completed');
    assert.equal(call.budget.requests, 1);
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0].output_config, { format: { type: 'json_schema', schema: schema.schema } });
    assert.equal(outcome.receipt.outputFormat, 'json-schema');
  });
}

test('#7132 native extraction reports provider limitation without inventing sent rows or budget exhaustion', async () => {
  const { dataStore } = await seedAuthoringSample();
  const wall = dataStore.entities.getByType(IfcTypeEnum.IfcWall)[0];
  assert.ok(wall);
  const passage = dataStore.entities.getName(wall);
  assert.ok(passage);
  const bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
  const grants = parseCapabilities(['network.ai']);
  assert.ok(grants.ok);
  const budget = createRootBudget();
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('No unsupported native request'); };
  await assert.rejects(async () => aiExtractNode.run({ laneKey: null, log: () => undefined,
    host: { bim, networkGrants: grants.value, ai: { model: 'claude-opus-5-5', request: call => runModelRequest({
      ...request(call.outputSchema), budget, system: call.system, messages: [{ role: 'user', content: call.prompt }],
    }) } } }, { passages: [passage] }, {
    fields: Array.from({ length: 17 }, (_, i) => ({ name: `Field${i}`, type: 'string' })),
    maxPassages: 50, batchSize: 10, maxRecords: 200, maxOutputTokens: 100,
  }), /Anthropic.*at most 16/);
  assert.equal(requests, 0);
  assert.equal(budget.requests, 0);
});

test('#7132 nested optional parameters and cyclic schemas refuse before the network', async () => {
  const optional = { type: 'object', properties: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [String(i), { type: 'string' }])),
    required: [], additionalProperties: false };
  const cyclic: Record<string, unknown> = { type: 'object', required: ['self'], additionalProperties: false };
  cyclic.properties = { self: cyclic };
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Invalid schemas must never dispatch'); };
  for (const [schema, reason] of [[{ type: 'object', properties: { nested: optional }, required: ['nested'], additionalProperties: false }, /24 optional/],
    [cyclic, /cyclic/]] as const) {
    const call = request({ name: 'limited', schema });
    const outcome = await runModelRequest(call);
    assert.ok(outcome.kind === 'refused' && outcome.reason === 'unsupported-schema');
    assert.match(outcome.message, reason);
    assert.equal(call.budget.requests, 0);
  }
  assert.equal(requests, 0);
});
