/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7132: a real native IFC population reaches a schema-constrained host request and review. */
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { restoreRootBudget, type UsageReceipt } from '@ifc-lite/ai';
import { fileURLToPath } from 'node:url';
import { NodeRegistry, runFlow, type FlowDocument, type NodeDef, type Table } from '@ifc-lite/flow';
import { aiNodes, AI_FEATURE } from '@ifc-lite/flow-nodes/ai';
import { headlessFeatures, type FlowHost } from '@ifc-lite/flow-nodes';
import { parseCapabilities } from '@ifc-lite/extensions';
import { createHeadlessContext } from '../loader.js';
import { createCliAiService } from './flow-ai.js';

afterEach(() => vi.restoreAllMocks());

it('forwards the native classification schema without sending unselected IFC attributes or bypassing review', async () => {
  const fixture = fileURLToPath(new URL('../../../../apps/viewer/public/samples/building-architecture.ifc', import.meta.url));
  const { bim } = await createHeadlessContext(fixture);
  const walls = bim.query().byType('IfcWall').toArray();
  expect(walls).toHaveLength(4);
  const table: Table = { key: 'key', columns: [{ name: 'key', type: 'identifier' }, { name: 'Type', type: 'label' }, { name: 'Private', type: 'text' }],
    rows: walls.map(wall => ({ key: String(wall.ref.expressId), Type: wall.type, Private: 'DO-NOT-SEND' })) };
  const sent: Record<string, unknown>[] = [], receipts: UsageReceipt[] = [], outputTexts: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push(body);
    const messages = body.messages as { content: string }[];
    const block = /<data>\n([\s\S]*)\n<\/data>/.exec(messages.at(-1)!.content);
    if (!block) throw new Error('Missing evidence block');
    const items = block[1].split('\n').map(line => ({ key: (JSON.parse(line) as { key: string }).key, label: 'wall', evidence: ['Type'] }));
    const text = JSON.stringify({ items }); outputTexts.push(text);
    return new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 3 } }));
  });
  // #7246 the actual CLI host must carry producer metadata and the resumed native grant.
  const budget = restoreRootBudget({ maxRequests: 3, maxOutputTokens: 100, requests: 1, outputTokens: 63 });
  if (!budget) throw new Error('Expected valid resumed budget');
  const native = createCliAiService({ model: 'configured-model', apiKey: 'test', baseUrl: 'https://example.invalid', structuredOutput: true }, budget);
  const ai: typeof native = { ...native, request: async call => {
    const outcome = await native.request(call);
    if (outcome.kind !== 'refused') receipts.push(outcome.receipt);
    return outcome;
  } };
  const source: NodeDef<FlowHost> = { type: 'test.nativeWalls', title: 'Native walls', category: 'test', capabilities: [], params: [], inputs: [],
    outputs: [{ name: 'table', type: { kind: 'table', access: 'item' } }], run: () => ({ table }) };
  const graph: FlowDocument = { flowVersion: 2, id: 'typed-native-walls', name: 'Typed native walls', capabilities: ['network.ai'], inputs: [], outputs: [],
    nodes: [{ id: 'walls', type: source.type }, { id: 'classify', type: 'ai.classify', params: {
      categories: [{ label: 'wall', definition: 'IFC walls' }], columns: ['Type'], maxRows: 10, batchSize: 10,
    } }], edges: [{ from: ['walls', 'table'], to: ['classify', 'table'] }] };
  const grants = parseCapabilities(['network.ai']);
  if (!grants.ok) throw new Error('Invalid test grant');
  const features = headlessFeatures();
  const result = await runFlow(graph, { registry: new NodeRegistry<FlowHost>().registerAll([source, ...aiNodes]),
    features: { ...features, backend: new Set([...features.backend, AI_FEATURE]) }, host: { bim, ai, grants: grants.value, networkGrants: grants.value } });
  expect(result.ok).toBe(true);
  expect(sent[0].max_tokens).toBe(37);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ usageReported: true, inputTokens: 11, outputTokens: 3, provenance: {
    promptVersion: 'flow.ai.classify.v1', grantedOutputTokens: 37, timeoutMs: 120_000, finishReason: 'stop',
    outputTextDigest: { referent: 'output-text.utf8.v1', value: createHash('sha256').update(outputTexts[0], 'utf8').digest('hex') },
  } });
  expect(JSON.stringify(receipts)).not.toContain('example.invalid');
  expect(budget.requests).toBe(2);
  expect(budget.outputTokens).toBe(66);
  expect(result.review).toEqual(['classify']);
  const output = result.outputs.get('classify')?.get('table');
  if (output?.kind !== 'item') throw new Error('Missing native classification result');
  expect((output.value as Table).rows).toHaveLength(walls.length);
  expect((output.value as Table).rows.every(row => row.outcome === 'classified' && row.evidence === 'Type')).toBe(true);
  expect(sent).toHaveLength(1);
  expect(JSON.stringify(sent)).not.toContain('DO-NOT-SEND');
  expect(sent[0].response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'flow_classification', strict: true,
    schema: { type: 'object', required: ['items'], additionalProperties: false } } });
});
