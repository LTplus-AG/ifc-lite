/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Flow AI nodes (#6923) against a deterministic stand-in model that runs
 * through the real `@ifc-lite/ai` request core and root budget. Invariants:
 * nothing the model invents (keys, labels, citations, spans, column names)
 * survives as evidence; the run's root budget bounds the requests of every AI
 * node, lane and batch together; a budget stop leaves a partial draft whose
 * coverage counts every row; only the selected columns leave the host; every
 * AI node pauses the run for review.
 */

import { describe, expect, it } from 'vitest';
import { createRootBudget, runModelRequest, type RootBudget } from '@ifc-lite/ai';
import { nodeAvailability, NodeRegistry, runFlow, type FlowDocument, type NodeDef, type Table } from '@ifc-lite/flow';
import { parseCapabilities } from '@ifc-lite/extensions';
import { createFakeBim } from './__tests__/fake-backend.js';
import { aiNodes, AI_FEATURE, type FlowAiCall, type FlowAiService } from './ai.js';
import { BROWSER_FEATURES, headlessFeatures, type FlowHost } from './index.js';

interface StandIn { service: FlowAiService; budget: RootBudget; calls: FlowAiCall[] }

/** A model that answers from the data block it is sent; `answer` sees the parsed data lines. */
function standIn(answer: (rows: Record<string, unknown>[], call: FlowAiCall) => unknown, limits = { maxRequests: 20, maxOutputTokens: 100_000 }, finish = 'stop'): StandIn {
  const budget = createRootBudget(limits);
  const calls: FlowAiCall[] = [];
  const service: FlowAiService = {
    model: 'stand-in',
    request: (call) => runModelRequest({
      model: 'stand-in', route: 'test', budget, routeCeiling: 4000, timeoutMs: 5000,
      messages: [call.prompt], system: call.system, maxOutputTokens: call.maxOutputTokens, signal: call.signal,
      transport: async (t) => {
        calls.push(call);
        const rows = /<data>\n([\s\S]*)\n<\/data>/.exec(call.prompt)![1].split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
        const text = JSON.stringify(answer(rows, call));
        t.onChunk(text);
        t.onFinishReason(finish);
        t.onTokenUsage({ inputTokens: 10, outputTokens: 5 });
        t.onComplete(text);
      },
    }),
  };
  return { service, budget, calls };
}

const tableNode: NodeDef<FlowHost> = {
  type: 't.table', title: 'Table', category: 't', inputs: [], outputs: [{ name: 't', type: { kind: 'table', access: 'item' } }],
  params: [{ name: 'n', kind: 'number', default: 4 }], capabilities: [],
  run: (_c, _i, p) => ({
    t: {
      key: 'GlobalId',
      columns: [{ name: 'GlobalId', type: 'identifier' }, { name: 'Type', type: 'label' }, { name: 'Owner', type: 'text' }],
      rows: Array.from({ length: p.n as number }, (_, i) => ({ GlobalId: `g${i}`, Type: i % 2 ? 'IfcDuctSegment' : 'IfcWall', Owner: `PRIVATE-${i}` })),
    } satisfies Table,
  }),
};
const tablesNode: NodeDef<FlowHost> = { ...tableNode, type: 't.tables', outputs: [{ name: 't', type: { kind: 'table', access: 'list' } }],
  run: (c, i, p) => ({ t: [0, 1, 2, 3].map(() => (tableNode.run(c, i, p) as { t: Table }).t) }) };
const registry = new NodeRegistry<FlowHost>().registerAll([tableNode, tablesNode, ...aiNodes]);

const categories = [{ label: 'structure', definition: 'load-bearing building elements' }, { label: 'services', definition: 'MEP distribution' }];
const classifyBy = (rows: Record<string, unknown>[]) => ({
  items: rows.map((r) => ({ key: r.key, label: (r.values as Record<string, unknown>).Type === 'IfcWall' ? 'structure' : 'services', evidence: ['Type'] })),
});

function graph(nodes: FlowDocument['nodes'], edges: FlowDocument['edges']): FlowDocument {
  return { flowVersion: 2, id: 'g', name: 'g', capabilities: ['network.ai'], inputs: [], outputs: [], nodes, edges };
}
const classifyGraph = (params: Record<string, unknown>, n = 4) => graph(
  [{ id: 'src', type: 't.table', params: { n } }, { id: 'ai', type: 'ai.classify', params: { categories, columns: ['Type'], ...params } }],
  [{ from: ['src', 't'], to: ['ai', 'table'] }],
);
const aiGrants = parseCapabilities(['network.ai']);
if (!aiGrants.ok) throw new Error('invalid test grant');
const host = (ai?: FlowAiService): FlowHost => ({ bim: createFakeBim().bim, networkGrants: aiGrants.value, ...(ai ? { ai } : {}) });
const features = { ...headlessFeatures(), backend: new Set([...headlessFeatures().backend, AI_FEATURE]) };

async function classify(params: Record<string, unknown>, model: StandIn, n = 4) {
  const result = await runFlow(classifyGraph(params, n), { host: host(model.service), registry, features });
  const out = result.outputs.get('ai');
  return { result, table: out?.get('table') as { kind: 'item'; value: Table } | undefined, coverage: (out?.get('coverage') as { value: Record<string, unknown> } | undefined)?.value };
}

describe('ai.classify', () => {
  it('labels every row with cited evidence and pauses the run for review', async () => {
    const model = standIn(classifyBy);
    const { result, table, coverage } = await classify({ columns: ['Type'] }, model);
    expect(result.review).toEqual(['ai']);
    expect(result.reports.find((r) => r.nodeId === 'ai')?.status).toBe('review');
    expect(table!.value.rows.map((r) => [r.key, r.label, r.evidence, r.outcome])).toEqual([
      ['g0', 'structure', 'Type', 'classified'], ['g1', 'services', 'Type', 'classified'],
      ['g2', 'structure', 'Type', 'classified'], ['g3', 'services', 'Type', 'classified'],
    ]);
    expect(coverage).toMatchObject({ model: 'stand-in', rows: 4, requests: 1, classified: 4, notSent: 0 });
    // Only the selected column left the host.
    expect(model.calls[0].prompt).not.toContain('PRIVATE-');
  });

  it('keeps nothing the model invented: unknown keys, labels outside the set, uncited or unsent evidence', async () => {
    const model = standIn((rows) => ({
      items: [
        { key: 'invented', label: 'structure', evidence: ['Type'] },
        { key: rows[0].key, label: 'demolition', evidence: ['Type'] },
        { key: rows[1].key, label: 'services', evidence: [] },
        { key: rows[2].key, label: 'structure', evidence: ['Owner'] },
        { key: rows[3].key, label: 'structure', evidence: ['Type'] },
        { key: rows[3].key, label: 'services', evidence: ['Type'] },
      ],
    }));
    const { table } = await classify({ columns: ['Type'] }, model);
    expect(table!.value.rows.map((r) => [r.key, r.label, r.outcome])).toEqual([
      ['g0', null, 'unknown'], ['g1', null, 'unknown'], ['g2', null, 'unknown'], ['g3', 'structure', 'classified'],
    ]);
  });

  it('stops at the root budget with a partial draft whose coverage counts every row', async () => {
    const model = standIn(classifyBy, { maxRequests: 3, maxOutputTokens: 100_000 });
    const { result, table, coverage } = await classify({ batchSize: 2 }, model, 10);
    expect(model.calls).toHaveLength(3);
    expect(coverage).toMatchObject({ rows: 10, requests: 3, classified: 6, notSent: 4 });
    expect(table!.value.rows.slice(6).every((r) => r.outcome === 'not-sent' && r.label === null)).toBe(true);
    expect(result.log.some((l) => l.level === 'warn' && /budget ran out/.test(l.message))).toBe(true);
  });

  it('bounds lifted lanes by one run-wide budget', async () => {
    const model = standIn(classifyBy, { maxRequests: 5, maxOutputTokens: 100_000 });
    const doc = graph(
      [{ id: 'src', type: 't.tables', params: { n: 4 } }, { id: 'ai', type: 'ai.classify', params: { categories, columns: ['Type'], batchSize: 2 } }],
      [{ from: ['src', 't'], to: ['ai', 'table'] }],
    );
    const result = await runFlow(doc, { host: host(model.service), registry, features });
    // Four lanes would need eight requests; the root allows five in total.
    expect(model.calls).toHaveLength(5);
    expect(model.budget.requests).toBe(5);
    expect(result.reports.find((r) => r.nodeId === 'ai')).toMatchObject({ status: 'review', lanes: 4 });
  });

  it('marks a batch whose reply was cut off as failed and still classifies the others', async () => {
    let call = 0;
    const model = standIn((rows) => (++call === 1 ? { items: [] } : classifyBy(rows)));
    const truncating = standIn(classifyBy, undefined, 'length');
    const cut = await classify({ batchSize: 2 }, truncating);
    expect(cut.table!.value.rows.every((r) => r.outcome === 'failed')).toBe(true);
    const { table } = await classify({ batchSize: 2 }, model);
    expect(table!.value.rows.map((r) => r.outcome)).toEqual(['failed', 'failed', 'classified', 'classified']);
    expect(cut.coverage).toMatchObject({ failed: 4, requests: 2 });
  });

  it('sends nothing past maxRows', async () => {
    const model = standIn(classifyBy);
    const { coverage } = await classify({ maxRows: 3 }, model, 5);
    expect(coverage).toMatchObject({ rows: 5, classified: 3, notSent: 2 });
  });
});

describe('ai.summarize', () => {
  it('keeps only citations of rows that were sent and marks unsupported sections uncited', async () => {
    const model = standIn((rows) => ({
      sections: [
        { heading: 'Walls', text: 'Two walls.', citations: [rows[0].key, rows[2].key, 'g99'] },
        { heading: 'Rumour', text: 'Something unsupported.', citations: ['g99'] },
        { heading: 'Empty', text: '', citations: [rows[0].key] },
      ],
    }));
    const doc = graph(
      [{ id: 'src', type: 't.table', params: { n: 4 } }, { id: 'sum', type: 'ai.summarize', params: { columns: ['Type'] } }],
      [{ from: ['src', 't'], to: ['sum', 'table'] }],
    );
    const result = await runFlow(doc, { host: host(model.service), registry, features });
    const sections = (result.outputs.get('sum')?.get('sections') as { value: Table }).value;
    expect(sections.rows).toEqual([
      { heading: 'Walls', text: 'Two walls.', citations: 'g0, g2', outcome: 'cited' },
      { heading: 'Rumour', text: 'Something unsupported.', citations: '', outcome: 'uncited' },
    ]);
    expect(result.review).toEqual(['sum']);
  });
});

describe('ai.extract', () => {
  // #7039: quote-and-type validation does not prove that a quoted passage entails a candidate value.
  it('marks structural support without claiming semantic entailment of typed values', async () => {
    const passages = ['Door D1 has a fire rating of 30 minutes.', 'Wall W2 is 240 mm thick.'];
    const model = standIn(() => ({
      records: [
        { passage: 0, span: 'fire rating of 30 minutes', values: { element: 'D1', minutes: 30 } },
        { passage: 1, span: '240 mm thick', values: { element: 'W2', minutes: '240' } },
        { passage: 1, span: 'rated 90 minutes', values: { element: 'W2', minutes: 90 } },
        { passage: 0, span: 'fire rating of 30 minutes', values: { element: 'D1', minutes: 999 } },
        { passage: 7, span: 'Door', values: { element: 'X', minutes: 1 } },
      ],
    }));
    const extract = aiNodes.find((n) => n.type === 'ai.extract')!;
    const out = await extract.run(
      { host: host(model.service), laneKey: null, log: () => undefined },
      { passages },
      { fields: [{ name: 'element', type: 'string' }, { name: 'minutes', type: 'number' }], maxPassages: 50, batchSize: 10, maxRecords: 200, maxOutputTokens: 2000 },
    ) as { records: Table; coverage: Record<string, unknown> };
    expect(out.records.rows).toEqual([
      { passage: 0, span: 'fire rating of 30 minutes', element: 'D1', minutes: 30, outcome: 'supported' },
      { passage: 1, span: '240 mm thick', element: 'W2', minutes: null, outcome: 'unsupported' },
      { passage: 1, span: 'rated 90 minutes', element: 'W2', minutes: 90, outcome: 'unsupported' },
      { passage: 0, span: 'fire rating of 30 minutes', element: 'D1', minutes: 999, outcome: 'supported' },
    ]);
    expect(out.coverage).toMatchObject({ passages: 2, sent: 2, records: 4, unsupported: 2 });
  });
});

describe('AI node host boundary', () => {
  it('is unavailable on hosts without an AI service, browser or headless', () => {
    for (const node of aiNodes) for (const f of [BROWSER_FEATURES, headlessFeatures()]) {
      expect(nodeAvailability(node, node.type, f)).toMatchObject({ status: 'unavailable', reasons: [expect.stringMatching(/"ai"/)] });
    }
  });

  it('refuses to send graph data without the network.ai grant', async () => {
    const model = standIn(classifyBy);
    const parsed = parseCapabilities(['model.read']);
    if (!parsed.ok) throw new Error('bad grants');
    const result = await runFlow(classifyGraph({}), { host: { ...host(model.service), grants: parsed.value }, registry, features });
    expect(result.ok).toBe(false);
    expect(result.reports.find((r) => r.nodeId === 'ai')?.error).toMatch(/network\.ai/);
    expect(model.calls).toHaveLength(0);
  });

  it('stops sending when the run is cancelled', async () => {
    const controller = new AbortController();
    const model = standIn((rows) => { controller.abort(); return classifyBy(rows); });
    const result = await runFlow(classifyGraph({ batchSize: 1 }), { host: host(model.service), registry, features, signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(model.calls).toHaveLength(1);
  });
});


it('#7039 empty and literal fallback row keys keep distinct classification evidence', async () => {
  const source: NodeDef<FlowHost> = { ...tableNode, run: () => ({ t: {
    key: 'GlobalId', columns: [{ name: 'GlobalId', type: 'identifier' }, { name: 'Type', type: 'label' }],
    rows: [{ GlobalId: '', Type: 'IfcWall' }, { GlobalId: '#0', Type: 'IfcDuctSegment' }],
  } satisfies Table }) };
  const local = new NodeRegistry<FlowHost>().registerAll([source, ...aiNodes]);
  const model = standIn(classifyBy);
  const result = await runFlow(classifyGraph({ columns: ['Type'] }), { host: host(model.service), registry: local, features });
  const table = result.outputs.get('ai')?.get('table') as { value: Table };
  expect(table.value.rows.map(row => row.label)).toEqual(['structure', 'services']);
  const lines = /<data>\n([\s\S]*)\n<\/data>/.exec(model.calls[0].prompt)![1].split('\n').map(line => JSON.parse(line) as { key: string });
  expect(new Set(lines.map(row => row.key)).size).toBe(2);
});

it('#7039 table AI nodes refuse omitted columns before sending private data', async () => {
  for (const type of ['ai.classify', 'ai.summarize']) {
    const model = standIn(classifyBy);
    const doc = graph([{ id: 'src', type: 't.table' }, { id: 'ai', type, params: { categories } }],
      [{ from: ['src', 't'], to: ['ai', 'table'] }]);
    const result = await runFlow(doc, { host: host(model.service), registry, features });
    expect(result.ok).toBe(false);
    expect(result.log.some(entry => entry.message.includes('Select at least one column'))).toBe(true);
    expect(model.calls).toEqual([]);
  }
});

// #7039: review inputs preserve identity, grant boundaries and honest incomplete coverage.
it('refuses AI without explicit grants even on a trusted local host', async () => {
  const model = standIn(classifyBy);
  const result = await runFlow(classifyGraph({}), { host: { bim: createFakeBim().bim, ai: model.service }, registry, features });
  expect(result.ok).toBe(false);
  expect(model.calls).toHaveLength(0);
});

it('keeps source key values separate from generated row identifiers', async () => {
  const source: NodeDef<FlowHost> = { ...tableNode, run: () => ({ t: {
    key: 'key', columns: [{ name: 'key', type: 'text' }, { name: 'Type', type: 'text' }],
    rows: [{ key: '', Type: 'IfcWall' }, { key: '', Type: 'IfcWall' }, { key: '#0', Type: 'IfcWall' }],
  } satisfies Table }) };
  const model = standIn(classifyBy);
  const result = await runFlow(classifyGraph({ columns: ['key', 'Type'] }), { host: host(model.service), registry: new NodeRegistry<FlowHost>().registerAll([source, ...aiNodes]), features });
  const table = result.outputs.get('ai')?.get('table');
  expect(table?.kind).toBe('item');
  if (table?.kind !== 'item') throw new Error('missing classified table');
  expect((table.value as Table).rows.map(row => [row.key, row.outcome])).toEqual([['#0:1', 'classified'], ['#1', 'classified'], ['#0', 'classified']]);
  expect(model.calls[0].prompt).toContain('"values":{"key":""');
});

it('marks a missing classification items array as a failed batch', async () => {
  const { table, coverage, result } = await classify({}, standIn(() => ({})));
  expect(result.review).toEqual(['ai']);
  expect(coverage).toMatchObject({ failed: 4, unknown: 0 });
  expect(table!.value.rows.every(row => row.outcome === 'failed')).toBe(true);
});

it('#7040 omitted classifications count as failures separately from explicit unknown answers', async () => {
  const { table, coverage, result } = await classify({}, standIn(rows => ({ items: [
    { key: rows[0].key, label: 'unknown', evidence: [] },
    { key: rows[1].key, label: 'structure', evidence: ['Type'] },
  ] })));
  expect(result.review).toEqual(['ai']);
  expect(table!.value.rows.map(row => row.outcome)).toEqual(['unknown', 'classified', 'failed', 'failed']);
  expect(coverage).toMatchObject({ rows: 4, classified: 1, unknown: 1, failed: 2, notSent: 0 });
});

it('keeps a budget-stopped second summary as a reviewable not-sent draft', async () => {
  const model = standIn(rows => ({ sections: [{ heading: 'Evidence', text: 'Wall evidence', citations: [rows[0].key] }] }), { maxRequests: 1, maxOutputTokens: 100_000 });
  const doc = graph([
    { id: 'src', type: 't.table', params: {} },
    { id: 'first', type: 'ai.summarize', params: { columns: ['Type'] } },
    { id: 'second', type: 'ai.summarize', params: { columns: ['Type'] } },
  ], [{ from: ['src', 't'], to: ['first', 'table'] }, { from: ['src', 't'], to: ['second', 'table'] }]);
  const result = await runFlow(doc, { host: host(model.service), registry, features });
  expect(result.ok).toBe(true);
  expect(result.review).toContain('second');
  const coverage = result.outputs.get('second')?.get('coverage');
  if (coverage?.kind !== 'item') throw new Error('missing coverage');
  expect(coverage.value).toMatchObject({ requests: 0, sent: 0, notSent: 4, budgetStopped: true });
  expect(model.calls).toHaveLength(1);
});

it('does not certify a fabricated suffix by truncating the claimed quote', async () => {
  const span = 'a'.repeat(1000);
  const model = standIn(() => ({ records: [{ passage: 0, span: `${span}invented`, values: { Name: 'claimed' } }] }));
  const source: NodeDef<FlowHost> = { ...tableNode, type: 't.passages', outputs: [{ name: 'passages', type: { kind: 'scalar', access: 'list' } }], run: () => ({ passages: [span] }) };
  const doc = graph([{ id: 'src', type: source.type, params: {} }, { id: 'ai', type: 'ai.extract', params: { fields: [{ name: 'Name', type: 'string' }] } }], [{ from: ['src', 'passages'], to: ['ai', 'passages'] }]);
  const result = await runFlow(doc, { host: host(model.service), registry: new NodeRegistry<FlowHost>().registerAll([source, ...aiNodes]), features });
  const records = result.outputs.get('ai')?.get('records');
  if (records?.kind !== 'item') throw new Error('missing records');
  expect((records.value as Table).rows[0].outcome).toBe('unsupported');
});

it('#7039 a missing extraction records array is a failed batch, not a successful empty finding', async () => {
  const model = standIn(() => ({}));
  const extract = aiNodes.find(node => node.type === 'ai.extract')!;
  const warnings: string[] = [];
  const out = await extract.run({ host: host(model.service), laneKey: null, log: (_level, message) => warnings.push(message) },
    { passages: ['Door D1 has a fire rating of 30 minutes.'] },
    { fields: [{ name: 'minutes', type: 'number' }], maxPassages: 50, batchSize: 10, maxRecords: 200, maxOutputTokens: 2000 }) as { records: Table; coverage: Record<string, unknown> };
  expect(out.records.rows).toEqual([]);
  expect(out.coverage).toMatchObject({ sent: 1, failed: 1, records: 0 });
  expect(warnings).toContain('passages 1-1: reply must contain a records array');
  expect(model.calls).toHaveLength(1);
});

it('#7039 a user AI grant cannot substitute for the graph declaration', async () => {
  const model = standIn(classifyBy);
  for (const networkGrants of [undefined, []]) {
    const result = await runFlow(classifyGraph({}), { host: { ...host(model.service), grants: aiGrants.value, networkGrants }, registry, features });
    expect(result.ok).toBe(false);
    expect(result.reports.find(r => r.nodeId === 'ai')?.error).toMatch(/network\.ai/);
  }
  expect(model.calls).toHaveLength(0);
});
