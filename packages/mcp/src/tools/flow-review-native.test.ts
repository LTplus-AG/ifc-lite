/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7070: real SketchUp IFC and the actual tool registry, transport, scheduler and disk CAS.
 * Fixed provider replies establish native orchestration, not generation quality. */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FlowDocument, Table } from '@ifc-lite/flow';
import { FileCheckpointStore } from '@ifc-lite/flow/checkpoint-file';
import { loadIfcModel, loadIfcModelFromBytes } from '../loader.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER, type ToolContext } from '../context.js';
import { fullScope, readOnlyScope } from '../auth/scope.js';
import { buildDefaultToolRegistry } from './index.js';

const registry = buildDefaultToolRegistry();
function tool(name: string) { const found = registry.get(name); expect(found, `${name} must be available`).toBeDefined(); if (!found) throw new Error(`Missing native ${name}`); return found; }
const directory = await mkdtemp(join(tmpdir(), 'ifc-mcp-review-'));
afterAll(() => rm(directory, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
let requests = 0;
let sentFormats: unknown[] = [];
let sentGrants: number[] = [];
let responseTexts: string[] = [];
beforeEach(() => {
  requests = 0;
  sentFormats = [];
  sentGrants = [];
  responseTexts = [];
  vi.stubEnv('IFC_LITE_AI_MODEL', 'fixture'); vi.stubEnv('IFC_LITE_AI_API_KEY', 'fixture-private-token');
  vi.stubEnv('IFC_LITE_AI_BASE_URL', 'https://fixture.invalid/v1');
  vi.stubEnv('IFC_LITE_AI_STRUCTURED_OUTPUT', 'true');
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    requests++;
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[]; response_format?: unknown; max_tokens: number };
    sentFormats.push(body.response_format);
    sentGrants.push(body.max_tokens);
    const prompt = body.messages.at(-1)!.content;
    const rows = /<data>\n([\s\S]*)\n<\/data>/.exec(prompt)![1].split('\n').map(line => JSON.parse(line) as { key: string });
    const text = JSON.stringify({ items: rows.map(row => ({ key: row.key, label: 'structure', evidence: ['Name'] })) });
    responseTexts.push(text);
    return new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }), { headers: { 'Content-Type': 'application/json' } });
  });
});

async function setup() {
  const models = new InMemoryModelRegistry();
  const model = await loadIfcModel(resolve('../../apps/viewer/public/samples/building-architecture.ifc'), { modelId: 'sample' });
  models.add(model);
  const context: ToolContext = { registry: models, scope: fullScope(), progress: NOOP_PROGRESS, log: SILENT_LOGGER,
    signal: new AbortController().signal, config: { ...DEFAULT_CONFIG, allowedPaths: [directory] } };
  const path = join(directory, `${crypto.randomUUID()}.json`);
  const flow: FlowDocument = { flowVersion: 2, id: 'classify', name: 'Classify native walls', capabilities: ['model.read', 'network.ai', 'model.mutate:*'], inputs: [],
    outputs: [{ nodeId: 'apply', port: 'entities', label: 'Applied' }],
    nodes: [{ id: 'walls', type: 'model.byType', params: { type: 'IfcWall' } },
      { id: 'findings', type: 'table.fromEntities', params: { columns: ['Name'] } },
      { id: 'draft', type: 'ai.classify', params: { columns: ['Name'], maxRows: 3, categories: [{ label: 'structure', definition: 'walls' }] } },
      { id: 'apply', type: 'model.applyTable', params: { mapping: [{ column: 'label', pset: 'Pset_AI', prop: 'Classification' }] } }],
    edges: [{ from: ['walls', 'entities'], to: ['findings', 'entities'] }, { from: ['findings', 'table'], to: ['draft', 'table'] }, { from: ['draft', 'table'], to: ['apply', 'table'] }] };
  return { context, model, path, flow };
}
async function pause(fixture: Awaited<ReturnType<typeof setup>>) {
  const result = await tool('run_flow').handler({ flow: fixture.flow, checkpoint_path: fixture.path }, fixture.context);
  const content = result.structuredContent as { ok: boolean; nodes: Record<string, number>; pending: { proposal_digest: string; budget: { requests: number; outputTokens: number }; artifacts: Record<string, unknown> } };
  expect(content.ok).toBe(true); expect(content.nodes.review).toBe(1); expect(content.nodes.paused).toBe(1);
  return content.pending;
}

it('returns a durable pending artifact; an explicit digest-approved second call applies native properties once without another request', async () => {
  const fixture = await setup(); const pending = await pause(fixture);
  expect(requests).toBe(1); expect(pending.budget).toMatchObject({ requests: 1, outputTokens: 10 });
  expect(sentFormats).toMatchObject([{ type: 'json_schema', json_schema: { name: 'flow_classification', strict: true,
    schema: { type: 'object', required: ['items'], additionalProperties: false } } }]);
  expect(fixture.model.backend.getMutationView()?.getEffectiveChanges() ?? []).toEqual([]);
  const stored = (await new FileCheckpointStore(fixture.path).load()).checkpoint;
  expect(stored.state).toBe('prepared');
  expect(stored.budget).toMatchObject({ usageReceipts: [expect.objectContaining({ model: 'fixture', route: 'mcp', outcome: 'completed', usageReported: true,
    outputFormat: 'json-schema', outputTokens: 10,
    // #7246: actual MCP producer metadata survives native disk checkpoint decoding.
    provenance: { contractVersion: 'ifc-lite.ai.request.v1', promptVersion: 'flow.ai.classify.v1',
      grantedOutputTokens: sentGrants[0], timeoutMs: 120_000, finishReason: 'stop',
      inputDigest: { algorithm: 'sha256', referent: 'logical-input.v1', value: expect.stringMatching(/^[a-f0-9]{64}$/) },
      outputTextDigest: { algorithm: 'sha256', referent: 'output-text.utf8.v1',
        value: createHash('sha256').update(responseTexts[0], 'utf8').digest('hex') } } })] });
  expect(sentGrants[0]).toBeGreaterThan(0);
  expect(stored.outputs.draft).toEqual(pending.artifacts.draft);
  expect(await readFile(fixture.path, 'utf8')).not.toContain('fixture-private-token');
  const input = { flow: fixture.flow, checkpoint_path: fixture.path, approved_digest: pending.proposal_digest };
  vi.stubEnv('IFC_LITE_AI_MODEL', ''); vi.stubEnv('IFC_LITE_AI_API_KEY', '');
  const result = await tool('resume_flow').handler(input, fixture.context);
  expect(result.structuredContent).toMatchObject({ ok: true, nodes: { restored: 3, ok: 1 } });
  expect(requests).toBe(1);
  const changes = fixture.model.backend.getMutationView()!.getEffectiveChanges();
  const table = stored.outputs.draft.table;
  if (table.kind !== 'item') throw new Error('Missing reviewed classification table');
  const classified = (table.value as Table).rows.filter(row => row.label === 'structure');
  expect(classified).toHaveLength(3);
  const content = fixture.model.bim.export.ifc();
  const exported = await loadIfcModelFromBytes(typeof content === 'string' ? new TextEncoder().encode(content) : content, 'reviewed.ifc', 'exported');
  for (const row of classified) {
    const id = fixture.model.store.entities.getExpressIdByGlobalId(String(row.key)); expect(id).toBeDefined();
    expect(fixture.model.backend.getMutationView()!.getPropertyValue(id!, 'Pset_AI', 'Classification')).toBe('structure');
    const reparsedId = exported.store.entities.getExpressIdByGlobalId(String(row.key)); expect(reparsedId).toBeDefined();
    const sets = exported.bim.properties({ modelId: exported.id, expressId: reparsedId! });
    expect(sets.find(set => set.name === 'Pset_AI')?.properties.find(property => property.name === 'Classification')?.value).toBe('structure');
  }
  expect((await new FileCheckpointStore(fixture.path).load()).checkpoint.state).toBe('completed');
  await expect(tool('resume_flow').handler(input, fixture.context)).rejects.toThrow();
  expect(fixture.model.backend.getMutationView()!.getEffectiveChanges()).toEqual(changes);
});

it('refuses changed evidence, graph, missing approval and revoked current permissions before claiming or mutating', async () => {
  const fixture = await setup(); const pending = await pause(fixture);
  const input = { flow: fixture.flow, checkpoint_path: fixture.path, approved_digest: pending.proposal_digest };
  await expect(tool('resume_flow').handler({ ...input, approved_digest: 'wrong' }, fixture.context)).rejects.toThrow(/exact reviewed/);
  await expect(tool('resume_flow').handler({ ...input, flow: { ...fixture.flow, name: 'Changed target' } }, fixture.context)).rejects.toThrow(/graph.*changed/);
  await expect(tool('resume_flow').handler(input, { ...fixture.context, scope: readOnlyScope() })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  const wall = fixture.model.bim.query().byType('IfcWall').toArray()[0];
  fixture.model.bim.mutate.setAttribute(wall.ref, 'Name', 'Changed after review');
  const before = fixture.model.backend.getMutationView()!.getEffectiveChanges();
  await expect(tool('resume_flow').handler(input, fixture.context)).rejects.toThrow(/models or files.*changed/);
  expect(fixture.model.backend.getMutationView()!.getEffectiveChanges()).toEqual(before);
  expect((await new FileCheckpointStore(fixture.path).load()).checkpoint.state).toBe('prepared');
  expect(requests).toBe(1);
});

it('requires a new allowed destination before making a review-capable request or overwriting user files', async () => {
  const fixture = await setup();
  await expect(tool('run_flow').handler({ flow: fixture.flow }, fixture.context)).rejects.toThrow(/checkpoint_path/);
  await writeFile(fixture.path, 'existing user artifact');
  await expect(tool('run_flow').handler({ flow: fixture.flow, checkpoint_path: fixture.path }, fixture.context)).rejects.toThrow(/overwrite/);
  expect(await readFile(fixture.path, 'utf8')).toBe('existing user artifact'); expect(requests).toBe(0);
  expect(fixture.model.backend.getMutationView()?.getEffectiveChanges() ?? []).toEqual([]);
});

it('preserves the exhausted root pool through a second pause instead of resetting it on continuation', async () => {
  const fixture = await setup();
  const original = fixture.flow.nodes.find(node => node.id === 'draft')!;
  const draft = { ...original, params: { ...original.params, batchSize: 1, maxRows: 4 } };
  fixture.flow = { ...fixture.flow,
    nodes: [...fixture.flow.nodes.map(node => node.id === 'draft' ? draft : node),
      { ...draft, id: 'independent-two' }, { ...draft, id: 'independent-three' },
      { id: 'next', type: 'ai.classify', params: { columns: ['label'], categories: [{ label: 'structure', definition: 'approved classification' }] } }],
    edges: [...fixture.flow.edges.filter(edge => edge.to[0] !== 'apply'), { from: ['findings', 'table'], to: ['independent-two', 'table'] },
      { from: ['findings', 'table'], to: ['independent-three', 'table'] }, { from: ['draft', 'table'], to: ['next', 'table'] },
      { from: ['next', 'table'], to: ['apply', 'table'] }],
  };
  const initial = await tool('run_flow').handler({ flow: fixture.flow, checkpoint_path: fixture.path }, fixture.context);
  const pending = (initial.structuredContent as { pending: { proposal_digest: string; budget: { requests: number } } }).pending;
  expect(pending.budget.requests).toBe(12); expect(requests).toBe(12);
  const nextPath = join(directory, `${crypto.randomUUID()}.json`);
  const continued = await tool('resume_flow').handler({ flow: fixture.flow, checkpoint_path: fixture.path,
    approved_digest: pending.proposal_digest, next_checkpoint_path: nextPath }, fixture.context);
  expect(continued.structuredContent).toMatchObject({ ok: true, pending: { budget: { requests: 12 }, artifacts: { next: {
    coverage: { kind: 'item', value: { requests: 0, notSent: 4, classified: 0 } },
  } } } });
  expect(requests).toBe(12); expect(fixture.model.backend.getMutationView()?.getEffectiveChanges() ?? []).toEqual([]);
  expect((await new FileCheckpointStore(fixture.path).load()).checkpoint.state).toBe('completed');
  expect((await new FileCheckpointStore(nextPath).load()).checkpoint.state).toBe('prepared');
});

it('lets only one racing continuation consume the disk approval', async () => {
  const fixture = await setup(); const pending = await pause(fixture);
  const input = { flow: fixture.flow, checkpoint_path: fixture.path, approved_digest: pending.proposal_digest };
  const results = await Promise.allSettled([tool('resume_flow').handler(input, fixture.context), tool('resume_flow').handler(input, fixture.context)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect((await new FileCheckpointStore(fixture.path).load()).checkpoint.state).toBe('completed');
  expect(requests).toBe(1);
});

it('refuses a credential echoed by native model evidence instead of writing it to a checkpoint', async () => {
  const fixture = await setup();
  const wall = fixture.model.bim.query().byType('IfcWall').toArray()[0];
  fixture.model.bim.mutate.setAttribute(wall.ref, 'Name', 'fixture-private-token');
  const before = fixture.model.backend.getMutationView()!.getEffectiveChanges();
  await expect(tool('run_flow').handler({ flow: fixture.flow, checkpoint_path: fixture.path }, fixture.context)).rejects.toThrow(/contains a secret/);
  await expect(readFile(fixture.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(fixture.model.backend.getMutationView()!.getEffectiveChanges()).toEqual(before);
  expect(requests).toBe(1);
});

it('consumes a cancelled continuation without applying or replaying the approved effects', async () => {
  const fixture = await setup(); const pending = await pause(fixture);
  const controller = new AbortController(); controller.abort();
  const input = { flow: fixture.flow, checkpoint_path: fixture.path, approved_digest: pending.proposal_digest };
  const result = await tool('resume_flow').handler(input, { ...fixture.context, signal: controller.signal });
  expect(result.structuredContent).toMatchObject({ ok: false });
  expect(fixture.model.backend.getMutationView()?.getEffectiveChanges() ?? []).toEqual([]);
  expect((await new FileCheckpointStore(fixture.path).load()).checkpoint.state).toBe('partially-committed');
  await expect(tool('resume_flow').handler(input, fixture.context)).rejects.toThrow();
  expect(requests).toBe(1);
});

it('lets a read-only caller draft native findings while refusing hidden or declared effect nodes before requesting', async () => {
  const fixture = await setup();
  await expect(tool('propose_flow').handler({ flow: fixture.flow, checkpoint_path: fixture.path },
    { ...fixture.context, scope: readOnlyScope() })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(requests).toBe(0);
  const readFlow = { ...fixture.flow, capabilities: ['model.read', 'network.ai'],
    nodes: fixture.flow.nodes.filter(node => node.id !== 'apply'), edges: fixture.flow.edges.filter(edge => edge.to[0] !== 'apply'), outputs: [] };
  const result = await tool('propose_flow').handler({ flow: readFlow, checkpoint_path: fixture.path }, { ...fixture.context, scope: readOnlyScope() });
  expect(result.structuredContent).toMatchObject({ ok: true, pending: { state: 'prepared' } });
  expect(fixture.model.backend.getMutationView()?.getEffectiveChanges() ?? []).toEqual([]);
  expect(requests).toBe(1);
});
