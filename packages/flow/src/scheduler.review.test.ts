/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review checkpoints in the scheduler (#6923): a node that declares
 * `review: 'required'` produces a proposal, and nothing downstream of it runs
 * until a caller resumes the run with the reviewed outputs. Resuming never
 * executes an already completed node again, so a write that ran before the
 * pause is not repeated.
 */

import { describe, expect, it, vi } from 'vitest';
import { FLOW_VERSION, type FlowDocument } from './document.js';
import { NodeRegistry } from './registry.js';
import { MemoCache, runFlow } from './scheduler.js';
import { createCheckpoint, resumeOutputs, graphDigest } from './checkpoint-record.js';
import { approveCheckpoint, claimCheckpoint, MemoryCheckpointStore, updateCheckpoint } from './checkpoint-state.js';
import type { FlowData } from './values.js';

interface Host {
  /** Every node execution, in order: the invariant is "no node runs twice across pause + resume". */
  executed: string[];
  /** Values the sink received. */
  sunk: unknown[];
}

const scalar = { kind: 'scalar', access: 'item' } as const;
const registry = new NodeRegistry<Host>().registerAll([
  {
    type: 't.source', title: 'Source', category: 't', inputs: [], outputs: [{ name: 'v', type: scalar }],
    params: [{ name: 'value', kind: 'number', default: 1 }], capabilities: [],
    run: (ctx, _i, p) => { ctx.host.executed.push('source'); return { v: p.value }; },
  },
  {
    type: 't.write', title: 'Write', category: 't', inputs: [{ name: 'v', type: scalar }], outputs: [{ name: 'v', type: scalar }],
    params: [], capabilities: [], writes: 'model',
    run: (ctx, i) => { ctx.host.executed.push('write'); return { v: i.v }; },
  },
  {
    type: 't.propose', title: 'Propose', category: 't', inputs: [{ name: 'v', type: scalar }], outputs: [{ name: 'proposal', type: scalar }],
    params: [], capabilities: [], volatile: true, review: 'required',
    run: (ctx, i) => { ctx.host.executed.push('propose'); return { proposal: `label-for-${String(i.v)}` }; },
  },
  {
    type: 't.sink', title: 'Sink', category: 't', inputs: [{ name: 'v', type: scalar }], outputs: [],
    params: [], capabilities: [], writes: 'model',
    run: (ctx, i) => { ctx.host.executed.push('sink'); ctx.host.sunk.push(i.v); return {}; },
  },
]);

// source -> write -> propose -> sink, plus an independent source2 -> sink2 branch.
const doc: FlowDocument = {
  flowVersion: FLOW_VERSION, id: 'g', name: 'review', capabilities: [], inputs: [], outputs: [],
  nodes: [
    { id: 'src', type: 't.source', params: { value: 7 } },
    { id: 'w', type: 't.write' },
    { id: 'p', type: 't.propose' },
    { id: 'sink', type: 't.sink' },
    { id: 'src2', type: 't.source', params: { value: 2 } },
    { id: 'sink2', type: 't.sink' },
  ],
  edges: [
    { from: ['src', 'v'], to: ['w', 'v'] },
    { from: ['w', 'v'], to: ['p', 'v'] },
    { from: ['p', 'proposal'], to: ['sink', 'v'] },
    { from: ['src2', 'v'], to: ['sink2', 'v'] },
  ],
};

async function reviewedOutputs(paused: Awaited<ReturnType<typeof runFlow>>) {
  const checkpoint = createCheckpoint({ doc, registry, result: paused, sourceDigest: 'test-source' });
  const store = new MemoryCheckpointStore();
  await store.write(approveCheckpoint(checkpoint, checkpoint.proposalDigest), null);
  return resumeOutputs(await updateCheckpoint(store, checkpoint.id, current => claimCheckpoint(current, {
    owner: 'native-test', graphDigest: graphDigest(doc, {}, registry), sourceDigest: 'test-source', leaseMs: 60_000,
  })));
}

const statuses = (result: Awaited<ReturnType<typeof runFlow>>) => Object.fromEntries(result.reports.map((r) => [r.nodeId, r.status]));

describe('review checkpoints', () => {
  it('pauses everything downstream of a proposal and runs independent branches', async () => {
    const host: Host = { executed: [], sunk: [] };
    const result = await runFlow(doc, { host, registry });
    expect(result.ok).toBe(true);
    expect(result.review).toEqual(['p']);
    expect(statuses(result)).toMatchObject({ src: 'ok', w: 'ok', p: 'review', sink: 'paused', src2: 'ok', sink2: 'ok' });
    expect(host.sunk).toEqual([2]);
    expect(result.outputs.get('p')?.get('proposal')).toEqual({ kind: 'item', value: 'label-for-7' });
  });

  it('resumes with the reviewed outputs without running any completed node again', async () => {
    const host: Host = { executed: [], sunk: [] };
    const paused = await runFlow(doc, { host, registry });
    const resumed = await runFlow(doc, { host, registry, resume: await reviewedOutputs(paused) });
    expect(resumed.ok).toBe(true);
    expect(resumed.review).toEqual([]);
    expect(statuses(resumed)).toMatchObject({ src: 'restored', w: 'restored', p: 'restored', sink: 'ok', src2: 'restored', sink2: 'restored' });
    // Each node ran exactly once across both runs: the write before the pause is not repeated.
    expect([...host.executed].sort()).toEqual(['propose', 'sink', 'sink', 'source', 'source', 'write'].sort());
    expect(host.sunk).toEqual([2, 'label-for-7']);
    expect(resumed.writes).toBe(1);
  });

  it('feeds downstream nodes the reviewed value, not a fresh evaluation', async () => {
    const host: Host = { executed: [], sunk: [] };
    const paused = await runFlow(doc, { host, registry });
    const proposal = paused.outputs.get('p') as Map<string, FlowData>;
    proposal.set('proposal', { kind: 'item', value: 'edited-by-reviewer' });
    await runFlow(doc, { host, registry, resume: await reviewedOutputs(paused) });
    expect(host.sunk).toEqual([2, 'edited-by-reviewer']);
    expect(host.executed.filter((n) => n === 'propose')).toHaveLength(1);
  });

  it('#7038 refuses raw paused outputs before any downstream write', async () => {
    const host: Host = { executed: [], sunk: [] };
    const paused = await runFlow(doc, { host, registry });
    await expect(runFlow(doc, { host, registry, resume: paused.outputs })).rejects.toThrow(/actively claimed/);
    expect(host.sunk).toEqual([2]);
  });

  it('#7038 refuses mutated or reused authorized outputs before a downstream write', async () => {
    const host: Host = { executed: [], sunk: [] };
    const paused = await runFlow(doc, { host, registry });
    const changed = await reviewedOutputs(paused);
    changed.delete('p');
    await expect(runFlow(doc, { host, registry, resume: changed })).rejects.toThrow(/unchanged outputs/);
    expect(host.sunk).toEqual([2]);
    const approved = await reviewedOutputs(paused);
    await runFlow(doc, { host, registry, resume: approved });
    await expect(runFlow(doc, { host, registry, resume: approved })).rejects.toThrow(/actively claimed/);
    expect(host.sunk).toEqual([2, 'label-for-7']);
  });
});


it('#7038 cached non-volatile proposals still require review before downstream writes', async () => {
  const memoRegistry = new NodeRegistry<Host>().registerAll(registry.list().map(def =>
    def.type === 't.propose' ? { ...def, volatile: false } : def));
  const graph: FlowDocument = { ...doc, nodes: doc.nodes.filter(node => ['src', 'p', 'sink'].includes(node.id)),
    edges: [{ from: ['src', 'v'], to: ['p', 'v'] }, { from: ['p', 'proposal'], to: ['sink', 'v'] }] };
  const host: Host = { executed: [], sunk: [] };
  const cache = new MemoCache();
  await runFlow(graph, { host, registry: memoRegistry, cache });
  const repeated = await runFlow(graph, { host, registry: memoRegistry, cache });
  expect(host.executed.filter(node => node === 'propose')).toHaveLength(1);
  expect(repeated.review).toEqual(['p']);
  expect(statuses(repeated)).toMatchObject({ src: 'memo', p: 'review', sink: 'paused' });
  expect(host.sunk).toEqual([]);
});

it('#7038 one claim cannot issue multiple maps to replay downstream effects', async () => {
  const host: Host = { executed: [], sunk: [] };
  const paused = await runFlow(doc, { host, registry });
  const checkpoint = createCheckpoint({ doc, registry, result: paused, sourceDigest: 'test-source' });
  const store = new MemoryCheckpointStore();
  await store.write(approveCheckpoint(checkpoint, checkpoint.proposalDigest), null);
  const claimed = await updateCheckpoint(store, checkpoint.id, current => claimCheckpoint(current, {
    owner: 'one-map', graphDigest: graphDigest(doc, {}, registry), sourceDigest: 'test-source', leaseMs: 60_000,
  }));
  const approved = resumeOutputs(claimed);
  expect(() => resumeOutputs(JSON.parse(JSON.stringify(claimed)))).toThrow(/already supplied/);
  await runFlow(doc, { host, registry, resume: approved });
  expect(host.sunk).toEqual([2, 'label-for-7']);
});


it('#7038 another process cannot resume a persisted applying checkpoint', async () => {
  const host: Host = { executed: [], sunk: [] };
  const paused = await runFlow(doc, { host, registry });
  const checkpoint = createCheckpoint({ doc, registry, result: paused, sourceDigest: 'test-source' });
  const store = new MemoryCheckpointStore();
  await store.write(approveCheckpoint(checkpoint, checkpoint.proposalDigest), null);
  const claimed = await updateCheckpoint(store, checkpoint.id, current => claimCheckpoint(current, {
    owner: 'first-process', graphDigest: graphDigest(doc, {}, registry), sourceDigest: 'test-source', leaseMs: 60_000,
  }));
  // A fresh module instance has the same empty ownership cache as another process.
  vi.resetModules();
  const otherProcess = await import('./checkpoint-record.js');
  const persisted = (await store.read(checkpoint.id))!.checkpoint;
  expect(() => otherProcess.resumeOutputs(persisted)).toThrow(/successful store claim/);
  expect(() => resumeOutputs(persisted)).toThrow(/successful store claim/);
  await expect(updateCheckpoint(store, checkpoint.id, current => claimCheckpoint(current, {
    owner: 'second-process', graphDigest: graphDigest(doc, {}, registry), sourceDigest: 'test-source', leaseMs: 60_000,
  }))).rejects.toThrow(/not reviewed|applying/);
  await runFlow(doc, { host, registry, resume: resumeOutputs(claimed) });
  expect(host.sunk).toEqual([2, 'label-for-7']);
});
