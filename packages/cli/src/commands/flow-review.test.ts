/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Headless pause, review and resume of a Flow AI graph (#6923), on the
 * shipped AI example against the real sample model. The provider is a
 * deterministic stand-in behind `fetch` (an OpenAI-compatible endpoint), so
 * the real CLI transport, request core and root budget are exercised.
 *
 * Invariants: nothing is written before approval; the reviewed labels (and
 * only those) are written; the resume sends no model request; a checkpoint
 * is consumed once; a model that changed after review is refused; a host
 * without an AI provider refuses the graph before opening the model.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLOW_VERSION, NodeRegistry, runFlow, type FlowDocument } from '@ifc-lite/flow';
import { createCheckpoint } from '@ifc-lite/flow/checkpoint';
import { flowCommand } from './flow.js';
import { FileCheckpointStore } from './flow-checkpoint.js';
import { createHeadlessContext } from '../loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE_IFC = resolve(here, '../../../../apps/viewer/public/samples/building-architecture.ifc');
const AI_FLOW = resolve(here, '../__fixtures__/flows/ai-wall-roles.flow.json');

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err.push(String(chunk)); return true; });
  return { out, err, json: () => JSON.parse(out.join('')) as Record<string, unknown> };
}

function exits() {
  return vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
}

/** The stand-in model: labels a wall by its IsExternal cell and cites that column. */
function provider(): { calls: string[] } {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push(String(url));
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const data = /<data>\n([\s\S]*)\n<\/data>/.exec(body.messages.at(-1)!.content)![1].split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const items = data.map((row) => ({
      key: row.key,
      label: (row.values as Record<string, unknown>)['Pset_WallCommon.IsExternal'] === true ? 'Facade' : 'Partition',
      evidence: ['Pset_WallCommon.IsExternal'],
    }));
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ items }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { calls };
}

/** Independent read-back through a fresh headless context: walls per written WallRole. */
const roles = async (path: string) => {
  const { bim } = await createHeadlessContext(path);
  const count = (role: string) => bim.query().byType('IfcWall').where('Pset_Coordination', 'WallRole', '=', role).count();
  return { Facade: count('Facade'), Partition: count('Partition'), external: bim.query().byType('IfcWall').where('Pset_WallCommon', 'IsExternal', '=', true).count() };
};

beforeEach(() => {
  vi.stubEnv('IFC_LITE_AI_MODEL', 'stand-in/model');
  vi.stubEnv('IFC_LITE_AI_API_KEY', 'test-key-never-printed');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('ifc-lite flow: reviewed AI pause and resume', () => {
  it('pauses with a checkpoint, writes only after approval, and resumes without a model request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-review-'));
    const checkpoint = join(dir, 'roles.checkpoint.json');
    const model = provider();

    let c = capture();
    let exit = exits();
    await expect(flowCommand(['run', AI_FLOW, SAMPLE_IFC, '--checkpoint', checkpoint, '--no-tracking', '--json'])).rejects.toThrow('exit 3');
    expect(exit).toHaveBeenCalledWith(3);
    const paused = c.json() as { ok: boolean; nodes: Record<string, number>; checkpoint: { proposalDigest: string } };
    expect(paused.nodes).toMatchObject({ review: 1, paused: 1 });
    expect(model.calls).toHaveLength(1);
    const file = await readFile(checkpoint, 'utf-8');
    expect(file).not.toContain('test-key-never-printed');
    expect(JSON.parse(file).checkpoint.budget).toMatchObject({ requests: 1, maxRequests: 12 });
    // #7039 JSON review includes the exact proposal values, not only their digest.
    c = capture();
    await flowCommand(['review', checkpoint, '--json']);
    const storedProposal = JSON.parse(file).checkpoint;
    expect(c.json()).toMatchObject({ proposalDigest: storedProposal.proposalDigest,
      proposal: Object.fromEntries(storedProposal.reviewNodes.map((id: string) => [id, storedProposal.outputs[id]])) });
    // #7039 Different ids must contend for the same file, never overwrite each other.
    const stored = await new FileCheckpointStore(checkpoint).load();
    const racePath = join(dir, 'race.json');
    const candidates = [{ ...stored.checkpoint, id: 'first-run' }, { ...stored.checkpoint, id: 'second-run' }];
    const writes = await Promise.all(candidates.map(candidate => new FileCheckpointStore(racePath).write(candidate, null)));
    expect(writes.filter(Boolean)).toHaveLength(1);
    const winner = await new FileCheckpointStore(racePath).load();
    const loser = candidates.find(candidate => candidate.id !== winner.checkpoint.id)!;
    expect(await new FileCheckpointStore(racePath).write(loser, null)).toBe(false);
    expect((await new FileCheckpointStore(racePath).load()).checkpoint).toEqual(winner.checkpoint);
    // #7039 A dead writer's stale lock is reclaimed within this first write.
    const stalePath = join(dir, 'stale.json');
    await writeFile(`${stalePath}.lock`, '');
    await utimes(`${stalePath}.lock`, new Date(0), new Date(0));
    expect(await new FileCheckpointStore(stalePath).write(candidates[0], null)).toBe(true);
    expect((await new FileCheckpointStore(stalePath).load()).checkpoint.id).toBe(candidates[0].id);


    vi.restoreAllMocks();

    // Resuming an unreviewed checkpoint is refused and writes nothing.
    c = capture();
    exit = exits();
    const done = join(dir, 'done.ifc');
    await expect(flowCommand(['resume', AI_FLOW, SAMPLE_IFC, '--checkpoint', checkpoint, '--out', done, '--no-tracking'])).rejects.toThrow('exit 1');
    expect(c.err.join('')).toMatch(/prepared, not reviewed/);
    vi.restoreAllMocks();

    // An approval must name the digest that was shown.
    c = capture();
    exit = exits();
    await expect(flowCommand(['review', checkpoint, '--approve', 'not-the-digest'])).rejects.toThrow('exit 1');
    vi.restoreAllMocks();
    c = capture();
    await flowCommand(['review', checkpoint, '--approve', paused.checkpoint.proposalDigest, '--json']);
    expect(c.json()).toMatchObject({ state: 'reviewed' });
    vi.restoreAllMocks();

    const replay = provider();
    c = capture();
    await flowCommand(['resume', AI_FLOW, SAMPLE_IFC, '--checkpoint', checkpoint, '--out', done, '--no-tracking', '--json']);
    const resumed = c.json() as { ok: boolean; nodes: Record<string, number> };
    expect(resumed).toMatchObject({ ok: true, nodes: { restored: 3, ok: 1 } });
    expect(replay.calls).toHaveLength(0);
    expect(JSON.parse(await readFile(checkpoint, 'utf-8')).checkpoint.state).toBe('completed');
    const written = await roles(done);
    expect(written.Facade + written.Partition).toBe(4);
    expect(written.Facade).toBe(written.external);
    expect(await roles(SAMPLE_IFC)).toMatchObject({ Facade: 0, Partition: 0 });
    vi.restoreAllMocks();

    // Consumed once: a second resume is refused.
    c = capture();
    exit = exits();
    await expect(flowCommand(['resume', AI_FLOW, SAMPLE_IFC, '--checkpoint', checkpoint, '--no-tracking'])).rejects.toThrow('exit 1');
    expect(c.err.join('')).toMatch(/completed, not reviewed/);
  });

  it('refuses a resume against a model that changed after review', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-review-'));
    const checkpoint = join(dir, 'cp.json');
    provider();
    let c = capture();
    exits();
    await expect(flowCommand(['run', AI_FLOW, SAMPLE_IFC, '--checkpoint', checkpoint, '--no-tracking', '--json'])).rejects.toThrow('exit 3');
    const digest = (c.json() as { checkpoint: { proposalDigest: string } }).checkpoint.proposalDigest;
    vi.restoreAllMocks();
    capture();
    await flowCommand(['review', checkpoint, '--approve', digest]);
    vi.restoreAllMocks();
    const other = join(dir, 'other.ifc');
    await copyFile(resolve(here, '../../../../apps/viewer/public/samples/hello-wall.ifc'), other);
    c = capture();
    exits();
    await expect(flowCommand(['resume', AI_FLOW, other, '--checkpoint', checkpoint, '--no-tracking'])).rejects.toThrow('exit 1');
    expect(c.err.join('')).toMatch(/models or files the run read changed after review/);
    expect(JSON.parse(await readFile(checkpoint, 'utf-8')).checkpoint.state).toBe('reviewed');
  });

  it('refuses an AI graph before opening the model when no provider is configured', async () => {
    vi.unstubAllEnvs();
    const model = provider();
    const c = capture();
    exits();
    await expect(flowCommand(['run', AI_FLOW, '/missing-model-proves-preflight.ifc', '--no-tracking'])).rejects.toThrow('exit 1');
    expect(c.err.join('')).toMatch(/Flow cannot run on this host: roles: backend feature "ai" is not available/);
    expect(model.calls).toHaveLength(0);
  });

  it('bounds every batch of the run by its root budget flag and keeps a partial draft', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-review-'));
    const graph = JSON.parse(await readFile(AI_FLOW, 'utf-8')) as { nodes: Array<{ id: string; params?: Record<string, unknown> }> };
    graph.nodes.find((n) => n.id === 'roles')!.params!.batchSize = 1;
    const small = join(dir, 'batch-of-one.flow.json');
    await writeFile(small, JSON.stringify(graph));
    const model = provider();
    const c = capture();
    exits();
    await expect(flowCommand(['run', small, SAMPLE_IFC, '--checkpoint', join(dir, 'cp.json'), '--ai-max-requests', '2', '--no-tracking', '--json'])).rejects.toThrow('exit 3');
    expect(model.calls).toHaveLength(2);
    const summary = c.json() as { outputs: Array<{ key: string; data: { value: Record<string, unknown> } }> };
    expect(summary.outputs.find((o) => o.key === 'roles.coverage')?.data.value).toMatchObject({ rows: 4, requests: 2, classified: 2, notSent: 2 });
  });

  it('requires --out when the run wrote before pausing, so the resume starts from that model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-review-'));
    const graph = JSON.parse(await readFile(AI_FLOW, 'utf-8')) as { capabilities: string[]; nodes: unknown[]; edges: Array<{ from: string[]; to: string[] }> };
    graph.capabilities.push('model.mutate:Pset_Review');
    graph.nodes.push({ id: 'mark', type: 'model.setProperty', params: { pset: 'Pset_Review', property: 'Sent' } }, { id: 'yes', type: 'core.string', params: { value: 'yes' } });
    graph.edges = graph.edges.filter((e) => e.from[0] !== 'walls');
    graph.edges.push({ from: ['walls', 'entities'], to: ['mark', 'entity'] }, { from: ['yes', 'value'], to: ['mark', 'value'] }, { from: ['mark', 'entity'], to: ['table', 'entities'] });
    const writing = join(dir, 'writes-first.flow.json');
    await writeFile(writing, JSON.stringify(graph));
    provider();
    let c = capture();
    exits();
    await expect(flowCommand(['run', writing, SAMPLE_IFC, '--checkpoint', join(dir, 'a.json'), '--no-tracking'])).rejects.toThrow('exit 1');
    expect(c.err.join('')).toMatch(/wrote to the model before pausing for review; pass --out/);
    vi.restoreAllMocks();
    provider();
    c = capture();
    exits();
    const pausedModel = join(dir, 'paused.ifc');
    await expect(flowCommand(['run', writing, SAMPLE_IFC, '--checkpoint', join(dir, 'b.json'), '--out', pausedModel, '--no-tracking', '--json'])).rejects.toThrow('exit 3');
    const { bim } = await createHeadlessContext(pausedModel);
    expect(bim.query().byType('IfcWall').where('Pset_Review', 'Sent', '=', 'yes').count()).toBe(4);
    // The checkpoint pins the written model: resuming from the original is refused.
    vi.restoreAllMocks();
    c = capture();
    const digest = JSON.parse(await readFile(join(dir, 'b.json'), 'utf-8')).checkpoint.proposalDigest as string;
    await flowCommand(['review', join(dir, 'b.json'), '--approve', digest]);
    vi.restoreAllMocks();
    c = capture();
    exits();
    await expect(flowCommand(['resume', writing, SAMPLE_IFC, '--checkpoint', join(dir, 'b.json'), '--no-tracking'])).rejects.toThrow('exit 1');
    expect(c.err.join('')).toMatch(/changed after review/);
    vi.restoreAllMocks();
    capture();
    await flowCommand(['resume', writing, pausedModel, '--checkpoint', join(dir, 'b.json'), '--no-tracking', '--json']);
  });
});


it('#7039 an opened model survives reviewed pause and resume through the required output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-open-review-'));
  const graph = JSON.parse(await readFile(AI_FLOW, 'utf-8')) as { capabilities: string[]; nodes: unknown[]; edges: Array<{ from: string[]; to: string[] }> };
  const url = 'https://files.cde.example/hello-wall.ifc';
  graph.capabilities.push('network.fetch:files.cde.example', 'model.create');
  graph.nodes.push({ id: 'download', type: 'documents.download', params: { url } }, { id: 'open', type: 'model.openFromSource' });
  graph.edges.push({ from: ['download', 'data'], to: ['open', 'data'] }, { from: ['download', 'name'], to: ['open', 'name'] },
    { from: ['open', 'modelId'], to: ['walls', 'modelId'] });
  const path = join(dir, 'opened.flow.json');
  await writeFile(path, JSON.stringify(graph));
  const bytes = await readFile(resolve(here, '../../../../apps/viewer/public/samples/hello-wall.ifc'));
  const installProvider = () => {
    const model = provider();
    const request = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation((input, init) => String(input) === url
      ? Promise.resolve(new Response(bytes, { headers: { 'Content-Type': 'application/x-step' } })) : request(input, init));
    return model;
  };
  installProvider();
  let captured = capture();
  exits();
  await expect(flowCommand(['run', path, SAMPLE_IFC, '--checkpoint', join(dir, 'refused.json'), '--no-tracking'])).rejects.toThrow('exit 1');
  expect(captured.err.join('')).toMatch(/opened a different model.*pass --out/);
  vi.restoreAllMocks();
  installProvider();
  captured = capture();
  exits();
  const checkpoint = join(dir, 'opened.json');
  const pausedModel = join(dir, 'paused.ifc');
  await expect(flowCommand(['run', path, SAMPLE_IFC, '--checkpoint', checkpoint, '--out', pausedModel, '--no-tracking', '--json'])).rejects.toThrow('exit 3');
  const digest = (captured.json() as { checkpoint: { proposalDigest: string } }).checkpoint.proposalDigest;
  expect((await createHeadlessContext(pausedModel)).bim.query().byType('IfcWall').count()).toBe(1);
  vi.restoreAllMocks();
  capture();
  await flowCommand(['review', checkpoint, '--approve', digest]);
  vi.restoreAllMocks();
  const resumedProvider = provider();
  capture();
  const done = join(dir, 'done.ifc');
  await flowCommand(['resume', path, pausedModel, '--checkpoint', checkpoint, '--out', done, '--no-tracking', '--json']);
  expect(resumedProvider.calls).toEqual([]);
  expect((await createHeadlessContext(done)).bim.query().byType('IfcWall').count()).toBe(1);
  const written = await roles(done);
  expect(written.Facade + written.Partition).toBe(1);
});

it('#7039 refuses a configured provider when network.ai is undeclared', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-grant-'));
  const graph = JSON.parse(await readFile(AI_FLOW, 'utf-8')) as { capabilities: string[] };
  graph.capabilities = graph.capabilities.filter(cap => cap !== 'network.ai');
  const path = join(dir, 'graph.json');
  await writeFile(path, JSON.stringify(graph));
  const model = provider();
  const c = capture();
  exits();
  await expect(flowCommand(['run', path, SAMPLE_IFC, '--checkpoint', join(dir, 'cp.json'), '--no-tracking'])).rejects.toThrow('exit 1');
  expect(model.calls).toHaveLength(0);
  expect(c.err.join('')).toContain('network.ai');
});

it('#7039 refuses persisted and displayed checkpoint outputs containing a declared secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-secret-'));
  const secret = 'private-credential-value-7039';
  vi.stubEnv('CHECKPOINT_TOKEN', secret);
  const graph = JSON.parse(await readFile(AI_FLOW, 'utf-8')) as { capabilities: string[]; nodes: unknown[] };
  graph.capabilities.push('secret.read:CHECKPOINT_TOKEN');
  graph.nodes.unshift({ id: 'private', type: 'core.string', params: { value: '{{secret:CHECKPOINT_TOKEN}}' } });
  const path = join(dir, 'graph.json');
  await writeFile(path, JSON.stringify(graph));
  provider();
  const c = capture();
  exits();
  const checkpoint = join(dir, 'cp.json');
  await expect(flowCommand(['run', path, SAMPLE_IFC, '--checkpoint', checkpoint, '--no-tracking'])).rejects.toThrow('exit 1');
  expect(c.err.join('')).toContain('paused outputs contain a secret');
  expect(c.out.join('') + c.err.join('')).not.toContain(secret);
  await expect(readFile(checkpoint)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('#7039 validates a second pause destination before consuming approval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-second-pause-'));
  const graph = JSON.parse(await readFile(AI_FLOW, 'utf-8')) as { nodes: Array<{ id: string; type: string; params: Record<string, unknown> }>; outputs: unknown[] };
  const apply = graph.nodes.find(node => node.id === 'apply')!;
  apply.type = 'ai.summarize';
  apply.params = { columns: ['label'] };
  graph.outputs = [];
  const path = join(dir, 'graph.json');
  await writeFile(path, JSON.stringify(graph));
  provider();
  capture();
  exits();
  const checkpoint = join(dir, 'first.json');
  await expect(flowCommand(['run', path, SAMPLE_IFC, '--checkpoint', checkpoint, '--no-tracking', '--json'])).rejects.toThrow('exit 3');
  vi.restoreAllMocks();
  capture();
  const digest = (await new FileCheckpointStore(checkpoint).load()).checkpoint.proposalDigest;
  await flowCommand(['review', checkpoint, '--approve', digest]);
  vi.restoreAllMocks();
  let c = capture();
  exits();
  await expect(flowCommand(['resume', path, SAMPLE_IFC, '--checkpoint', checkpoint, '--no-tracking'])).rejects.toThrow('exit 1');
  expect(c.err.join('')).toContain('--next-checkpoint');
  expect((await new FileCheckpointStore(checkpoint).load()).checkpoint.state).toBe('reviewed');
  vi.restoreAllMocks();
  c = capture();
  exits();
  const next = join(dir, 'occupied.json');
  await writeFile(next, 'original');
  await expect(flowCommand(['resume', path, SAMPLE_IFC, '--checkpoint', checkpoint, '--next-checkpoint', next, '--no-tracking'])).rejects.toThrow('exit 1');
  expect(c.err.join('')).toContain('already exists');
  expect((await new FileCheckpointStore(checkpoint).load()).checkpoint.state).toBe('reviewed');
  expect(await readFile(next, 'utf-8')).toBe('original');
});

it('#7039 an upstream tracked creation refused without --out never flushes its sidecar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-tracking-pause-'));
  const graph = JSON.parse(await readFile(resolve(here, '../__fixtures__/flows/columns-along-x.flow.json'), 'utf-8')) as { flowVersion: number; capabilities: string[]; nodes: unknown[]; edges: unknown[]; outputs: unknown[] };
  const ai = JSON.parse(await readFile(AI_FLOW, 'utf-8')) as { nodes: Array<{ id: string; params: Record<string, unknown> }> };
  const roles = ai.nodes.find(node => node.id === 'roles')!;
  roles.params.columns = ['Name'];
  graph.flowVersion = 2;
  graph.capabilities.push('network.ai');
  graph.nodes.push({ id: 'table', type: 'table.fromEntities', params: { columns: ['Name'] } }, roles);
  graph.edges.push({ from: ['add', 'entity'], to: ['table', 'entities'] }, { from: ['table', 'table'], to: ['roles', 'table'] });
  graph.outputs = [];
  const path = join(dir, 'graph.json');
  await writeFile(path, JSON.stringify(graph));
  const tracking = join(dir, 'tracking.json');
  const model = provider();
  const c = capture();
  exits();
  await expect(flowCommand(['run', path, SAMPLE_IFC, '--checkpoint', join(dir, 'cp.json'), '--tracking', tracking])).rejects.toThrow('exit 1');
  expect(model.calls).toHaveLength(1);
  expect(c.err.join('')).toContain('wrote to the model before pausing');
  await expect(readFile(tracking)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('#7039 JSON review preserves every grouped proposal branch and nested value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-group-review-'));
  const path = join(dir, 'group.checkpoint.json');
  const doc: FlowDocument = { flowVersion: FLOW_VERSION, id: 'recorded-grouped-proposal', name: 'Grouped proposal',
    capabilities: ['network.ai'], inputs: [], outputs: [], nodes: [{ id: 'proposal', type: 'test.grouped-review' }], edges: [] };
  const table = { key: 'key', columns: [{ name: 'key', type: 'identifier' }, { name: 'label', type: 'label' }],
    rows: [{ key: 'source-key', label: 'Recorded review value' }] };
  const branches: Array<[string, unknown[]]> = [['branch-A', [table]], ['branch-B', [table]]];
  const registry = new NodeRegistry().register({ type: 'test.grouped-review', title: 'Grouped review', category: 'test',
    inputs: [], outputs: [{ name: 'table', type: { kind: 'table', access: 'group' } }], params: [], capabilities: [],
    review: 'required', run: () => ({ table: new Map(branches) }) });
  const result = await runFlow(doc, { host: {}, registry });
  expect(result.review).toEqual(['proposal']);
  const checkpoint = createCheckpoint({ doc, registry, result, sourceDigest: 'recorded-source' });
  expect(await new FileCheckpointStore(path).write(checkpoint, null)).toBe(true);
  const c = capture();
  await flowCommand(['review', path, '--json']);
  expect(c.json()).toMatchObject({ proposal: { proposal: { table: { kind: 'group', branches } } } });
});
