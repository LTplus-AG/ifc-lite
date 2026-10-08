/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7070: a proposal is bounded evidence, never authority to mutate. */
import { expect, it } from 'vitest';
import { createRootBudget, runModelRequest, type UsageReceipt } from '@ifc-lite/ai';
import { NodeRegistry, runFlow, type FlowDocument, type NodeDef, type Table } from '@ifc-lite/flow';
import { parseCapabilities } from '@ifc-lite/extensions';
import { aiNodes, AI_FEATURE, type FlowAiService } from './ai.js';
import { headlessFeatures, type FlowHost } from './index.js';
import { createFakeBim } from './__tests__/fake-backend.js';

const id = '0000000000000000000001';
const table: Table = { key: 'GlobalId', columns: [
  { name: 'GlobalId', type: 'identifier' }, { name: 'Name', type: 'text' }, { name: 'Private', type: 'text' },
], rows: [{ GlobalId: id, Name: 'Old', Private: 'NEVER-SEND' }, { GlobalId: '0000000000000000000002', Name: 'Other' }] };
const source: NodeDef<FlowHost> = { type: 'test.findings', title: 'Findings', category: 'test', inputs: [],
  outputs: [{ name: 'table', type: { kind: 'table', access: 'item' } }], params: [], capabilities: [], run: () => ({ table }) };
const params = { artifactKind: 'model.changes', instructions: 'Rename the selected finding', columns: ['GlobalId', 'Name'],
  targetColumn: 'GlobalId', modelColumn: '', fields: [{ op: 'attribute.set', name: 'Name', expectedColumn: 'Name', allowedValues: ['Reviewed'] }],
  maxRows: 1, maxChanges: 1, maxOutputTokens: 1000 };
const answer = () => ({ artifact: { version: 1, kind: 'model.changes', title: 'Rename', changes: [
  { op: 'attribute.set', target: { globalId: id }, name: 'Name', expected: 'Old', value: 'Reviewed' },
] }, citations: [id] });
const grants = parseCapabilities(['network.ai']);
if (!grants.ok) throw new Error('Invalid fixture grants');
const capabilities = grants.value;

async function run(reply: unknown = answer(), patch: Record<string, unknown> = {}, options: { finish?: string; requests?: number; granted?: boolean; signal?: AbortSignal; table?: Table } = {}) {
  const budget = createRootBudget({ maxRequests: Math.max(1, options.requests ?? 1), maxOutputTokens: 4000 });
  if (options.requests === 0) budget.requests = budget.maxRequests;
  const prompts: string[] = [];
  const receipts: UsageReceipt[] = [];
  const ai: FlowAiService = { model: 'fixture', request: call => runModelRequest({ model: 'fixture', route: 'fixture', budget,
    routeCeiling: 1000, timeoutMs: 1000, messages: [call.prompt], system: call.system, promptVersion: call.promptVersion, signal: call.signal, maxOutputTokens: call.maxOutputTokens,
    transport: async transport => { prompts.push(call.prompt); const text = JSON.stringify(reply); transport.onChunk(text);
      transport.onFinishReason(options.finish ?? 'stop'); transport.onComplete(text); },
  }, { onReceipt: receipt => receipts.push(receipt) }) };
  const doc: FlowDocument = { flowVersion: 2, id: 'proposal', name: 'Proposal', inputs: [], outputs: [], capabilities: ['network.ai'],
    nodes: [{ id: 'source', type: source.type }, { id: 'proposal', type: 'ai.propose', params: { ...params, ...patch } }],
    edges: [{ from: ['source', 'table'], to: ['proposal', 'table'] }] };
  const features = headlessFeatures();
  const result = await runFlow(doc, { registry: new NodeRegistry<FlowHost>().registerAll([{ ...source, run: () => ({ table: options.table ?? table }) }, ...aiNodes]),
    features: { ...features, backend: new Set([...features.backend, AI_FEATURE]) }, signal: options.signal,
    host: { bim: createFakeBim().bim, ai, networkGrants: capabilities, grants: options.granted === false ? [] : capabilities } });
  return { result, prompts, budget, receipts };
}

it('keeps a canonical portable artifact at review, sending only selected bounded findings', async () => {
  const { result, prompts, budget, receipts } = await run();
  // #7246 proposal identity is declared by its native producer, retained by the canonical request owner.
  expect(receipts[0].provenance).toMatchObject({ promptVersion: 'flow.ai.propose.v1', finishReason: 'stop', grantedOutputTokens: 1000 });
  expect(result.ok).toBe(true);
  expect(result.review).toEqual(['proposal']);
  expect(result.outputs.get('proposal')?.get('proposal')).toMatchObject({ kind: 'item', value: answer() });
  expect(result.outputs.get('proposal')?.get('coverage')).toMatchObject({ value: { rows: 2, sent: 1, notSent: 1, requests: 1, changes: 1 } });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).not.toContain('NEVER-SEND');
  expect(prompts[0]).not.toContain('Other');
  expect(budget.requests).toBe(1);
});

it.each([
  ['invented target', (value: ReturnType<typeof answer>) => { value.artifact.changes[0].target.globalId = '0000000000000000000099'; }],
  ['invented current value', (value: ReturnType<typeof answer>) => { value.artifact.changes[0].expected = 'Invented'; }],
  ['unselected field', (value: ReturnType<typeof answer>) => { value.artifact.changes[0].name = 'Description'; }],
  ['unapproved candidate', (value: ReturnType<typeof answer>) => { value.artifact.changes[0].value = 'Invented'; }],
  ['unsent citation', (value: ReturnType<typeof answer>) => { value.citations = ['0000000000000000000002']; }],
  ['duplicate citation', (value: ReturnType<typeof answer>) => { value.citations.push(id); }],
])('refuses %s without retaining an executable artifact', async (_name, mutate) => {
  const value = answer(); mutate(value);
  const { result, prompts } = await run(value);
  expect(result.ok).toBe(false);
  expect(result.outputs.has('proposal')).toBe(false);
  expect(prompts).toHaveLength(1);
});

it.each([
  { artifactKind: 'model.authoring' }, { columns: [] }, { targetColumn: 'Private' },
  { fields: [{ op: 'attribute.set', name: 'GlobalId', expectedColumn: 'Name', allowedValues: ['Reviewed'] }] },
  { fields: [{ op: 'property.set', pset: 'P', name: 'IsExternal', expectedColumn: 'Name', allowedValues: ['yes'], dataType: 'IfcBoolean' }] },
])('refuses an unsupported or invalid graph constraint before spending: %j', async patch => {
  const { result, prompts } = await run(answer(), patch);
  expect(result.ok).toBe(false);
  expect(prompts).toEqual([]);
});

it('refuses clarification and truncated replies without retrying or publishing a draft', async () => {
  for (const [reply, finish] of [[{ kind: 'clarification', message: 'Which wall?' }, 'stop'],
    [{ artifact: null, citations: [], clarification: 'Which wall?' }, 'stop'], [answer(), 'length']] as const) {
    const { result, prompts } = await run(reply, {}, { finish });
    expect(result.ok).toBe(false); expect(result.review).toEqual([]); expect(prompts).toHaveLength(1);
  }
});

it('honours revoked grants, cancellation and an exhausted root pool before sending', async () => {
  const controller = new AbortController(); controller.abort();
  for (const options of [{ granted: false }, { requests: 0 }, { signal: controller.signal }]) {
    const { result, prompts } = await run(answer(), {}, options);
    expect(result.ok).toBe(false); expect(prompts).toEqual([]);
  }
});

it('refuses ambiguous targets and unused citations even when each individual row is valid', async () => {
  const duplicate: Table = { ...table, rows: [table.rows[0], { ...table.rows[0] }] };
  const value = answer(); value.citations.push('#1');
  const ambiguous = await run(value, { maxRows: 2 }, { table: duplicate });
  expect(ambiguous.result.ok).toBe(false);
  const unused = answer(); unused.citations.push('0000000000000000000002');
  expect((await run(unused, { maxRows: 2 })).result.ok).toBe(false);
});

it('validates property, quantity and delete bindings through the shared native parser', async () => {
  const bindings = [
    { op: 'property.set', pset: 'Pset_WallCommon', name: 'IsExternal', dataType: 'IfcBoolean', expected: null, value: true },
    { op: 'quantity.set', qset: 'Qto_WallBaseQuantities', name: 'Length', expected: 1, value: 2 },
    { op: 'property.delete', pset: 'Pset_WallCommon', name: 'FireRating', expected: 'EI30' },
  ];
  for (const binding of bindings) {
    const { expected, ...field } = binding;
    const { value: candidate, ...nativeField } = field;
    const findings: Table = { key: 'GlobalId', columns: [{ name: 'GlobalId', type: 'identifier' }, { name: 'Current', type: 'text' }], rows: [{ GlobalId: id, Current: expected }] };
    const reply = { artifact: { version: 1, kind: 'model.changes', title: 'Correction', changes: [{ ...binding, target: { globalId: id } }] }, citations: [id] };
    const patch = { columns: ['GlobalId', 'Current'], fields: [{ ...nativeField, expectedColumn: 'Current', ...(candidate !== undefined ? { allowedValues: [candidate] } : {}) }] };
    const { result } = await run(reply, patch, { table: findings });
    expect(result.ok).toBe(true); expect(result.review).toEqual(['proposal']);
  }
});

it('#7081 refuses a delimiter-colliding field outside the graph constraints', async () => {
  const reply = { artifact: { version: 1, kind: 'model.changes', title: 'Substituted native field', changes: [
    { op: 'property.set', target: { globalId: id }, pset: 'A', name: 'B:C', expected: 'Old', value: 'Reviewed' },
  ] }, citations: [id] };
  const { result, prompts } = await run(reply, { fields: [{ op: 'property.set', pset: 'A:B', name: 'C', expectedColumn: 'Name', allowedValues: ['Reviewed'] }] });
  expect(result.ok).toBe(false); expect(result.outputs.has('proposal')).toBe(false);
  expect(result.reports.find(report => report.nodeId === 'proposal')?.error).toContain('outside the selected native fields');
  expect(prompts).toHaveLength(1);
});
