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
  items: rows.map((r) => ({ key: r.key, label: r.Type === 'IfcWall' ? 'structure' : 'services', evidence: ['Type'] })),
});

function graph(nodes: FlowDocument['nodes'], edges: FlowDocument['edges']): FlowDocument {
  return { flowVersion: 2, id: 'g', name: 'g', capabilities: ['network.ai'], inputs: [], outputs: [], nodes, edges };
}
const classifyGraph = (params: Record<string, unknown>, n = 4) => graph(
  [{ id: 'src', type: 't.table', params: { n } }, { id: 'ai', type: 'ai.classify', params: { categories, ...params } }],
  [{ from: ['src', 't'], to: ['ai', 'table'] }],
);
const host = (ai?: FlowAiService): FlowHost => ({ bim: createFakeBim().bim, ...(ai ? { ai } : {}) });
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
      [{ id: 'src', type: 't.tables', params: { n: 4 } }, { id: 'ai', type: 'ai.classify', params: { categories, batchSize: 2 } }],
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
    expect(table!.value.rows.map((r) => r.outcome)).toEqual(['unknown', 'unknown', 'classified', 'classified']);
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
  it('keeps a record as supported only when its span is verbatim in its passage and its values are typed', async () => {
    const passages = ['Door D1 has a fire rating of 30 minutes.', 'Wall W2 is 240 mm thick.'];
    const model = standIn(() => ({
      records: [
        { passage: 0, span: 'fire rating of 30 minutes', values: { element: 'D1', minutes: 30 } },
        { passage: 1, span: '240 mm thick', values: { element: 'W2', minutes: '240' } },
        { passage: 1, span: 'rated 90 minutes', values: { element: 'W2', minutes: 90 } },
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
    ]);
    expect(out.coverage).toMatchObject({ passages: 2, sent: 2, records: 3, unsupported: 2 });
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
