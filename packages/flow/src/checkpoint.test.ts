/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review checkpoints (#6923). Invariants: a checkpoint is plain JSON and
 * survives a JSON round trip unchanged; only the proposal a reviewer approved
 * (by digest) can be claimed; it is claimed at most once, also under
 * concurrent claims; a graph or source change after review refuses the
 * claim; an owner lost mid-resume never hands the checkpoint to a second
 * owner.
 */

import { describe, expect, it, vi } from 'vitest';
import { CheckpointNotPortableError, checkpointProposal, createCheckpoint, graphDigest, resumeOutputs, type FlowCheckpoint } from './checkpoint-record.js';
import {
  approveCheckpoint, CheckpointError, claimCheckpoint, finishCheckpoint, MemoryCheckpointStore, parseCheckpoint,
  recoverCheckpoint, rejectCheckpoint, updateCheckpoint,
} from './checkpoint-state.js';
import { FLOW_VERSION, type FlowDocument } from './document.js';
import { NodeRegistry } from './registry.js';
import { runFlow } from './scheduler.js';

const table = { kind: 'table', access: 'item' } as const;
interface Host { sunk: unknown[]; handle?: unknown }
const registry = new NodeRegistry<Host>().registerAll([
  {
    type: 't.rows', title: 'Rows', category: 't', inputs: [], outputs: [{ name: 't', type: table }], params: [], capabilities: [],
    run: (ctx) => ({ t: ctx.host.handle ?? { columns: [{ name: 'GlobalId', type: 'identifier' }], rows: [{ GlobalId: 'a' }, { GlobalId: 'b' }], key: 'GlobalId' } }),
  },
  {
    type: 't.classify', title: 'Classify', category: 't', inputs: [{ name: 't', type: table }], outputs: [{ name: 'labels', type: { kind: 'scalar', access: 'list' } }],
    params: [], capabilities: [], volatile: true, review: 'required',
    run: () => ({ labels: ['wall', 'unknown'] }),
  },
  {
    type: 't.sink', title: 'Sink', category: 't', inputs: [{ name: 'v', type: { kind: 'scalar', access: 'list' } }], outputs: [], params: [], capabilities: [], writes: 'model',
    run: (ctx, i) => { ctx.host.sunk.push(i.v); return {}; },
  },
]);
const doc: FlowDocument = {
  flowVersion: FLOW_VERSION, id: 'g', name: 'classify', capabilities: [], inputs: [], outputs: [],
  nodes: [{ id: 'rows', type: 't.rows', pos: [0, 0] }, { id: 'ai', type: 't.classify' }, { id: 'sink', type: 't.sink' }],
  edges: [{ from: ['rows', 't'], to: ['ai', 't'] }, { from: ['ai', 'labels'], to: ['sink', 'v'] }],
};

async function paused(host: Host = { sunk: [] }): Promise<FlowCheckpoint> {
  const result = await runFlow(doc, { host, registry });
  return createCheckpoint({ doc, registry, result, sourceDigest: 'model-hash-1', budget: { requests: 2 }, now: 1_000 });
}

const claim = (owner: string, now = 2_000) => ({ owner, graphDigest: graphDigest(doc, {}, registry), sourceDigest: 'model-hash-1', leaseMs: 60_000, now });

async function ownedClaim(checkpoint: FlowCheckpoint, input: Parameters<typeof claimCheckpoint>[1]): Promise<FlowCheckpoint> {
  const store = new MemoryCheckpointStore();
  await store.write(checkpoint, null);
  return updateCheckpoint(store, checkpoint.id, current => claimCheckpoint(current, input));
}

describe('createCheckpoint', () => {
  it('is plain JSON that round-trips and resumes the downstream node once with the reviewed value', async () => {
    const checkpoint = await paused();
    const revived = parseCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
    expect(revived).toEqual(checkpoint);
    expect(checkpoint).toMatchObject({ state: 'prepared', reviewNodes: ['ai'], budget: { requests: 2 } });
    expect([...checkpointProposal(revived).keys()]).toEqual(['ai']);
    const host: Host = { sunk: [] };
    const resumed = await runFlow(doc, { host, registry, resume: resumeOutputs(await ownedClaim(approveCheckpoint(revived, revived.proposalDigest, 1_500), claim('owner', Date.now()))) });
    expect(host.sunk).toEqual([['wall', 'unknown']]);
    expect(resumed.reports.find((r) => r.nodeId === 'ai')?.status).toBe('restored');
  });

  it('names the node and port of a value that is not plain JSON', async () => {
    const host: Host = { sunk: [], handle: new Map([['opaque', 1]]) };
    await expect(paused(host)).rejects.toThrow(CheckpointNotPortableError);
    await expect(paused(host)).rejects.toThrow(/rows\.t/);
    class Handle { readonly token = 'viewer-only'; }
    await expect(paused({ sunk: [], handle: { key: 'GlobalId', columns: [], rows: [], extra: new Handle() } })).rejects.toThrow(/rows\.t\.extra/);
  });

  it('ignores layout but not params or Player inputs in the graph digest', () => {
    const moved = { ...doc, nodes: doc.nodes.map((n) => ({ ...n, pos: [9, 9] as const })) };
    expect(graphDigest(moved, {}, registry)).toBe(graphDigest(doc, {}, registry));
    const edited = { ...doc, nodes: doc.nodes.map((n) => (n.id === 'ai' ? { ...n, params: { categories: ['x'] } } : n)) };
    expect(graphDigest(edited, {}, registry)).not.toBe(graphDigest(doc, {}, registry));
    expect(graphDigest(doc, { 'rows.limit': 3 }, registry)).not.toBe(graphDigest(doc, {}, registry));
  });
});

describe('checkpoint lifecycle', () => {
  it('approves only the digest the reviewer saw', async () => {
    const checkpoint = await paused();
    expect(() => approveCheckpoint(checkpoint, 'other-digest')).toThrow(/different proposal/);
    expect(approveCheckpoint(checkpoint, checkpoint.proposalDigest).state).toBe('reviewed');
    expect(() => claimCheckpoint(checkpoint, claim('tab-a'))).toThrow(CheckpointError);
    expect(rejectCheckpoint(checkpoint).state).toBe('rejected');
  });

  it('refuses a proposal edited after approval', async () => {
    const reviewed = approveCheckpoint(await paused(), (await paused()).proposalDigest);
    const tampered = JSON.parse(JSON.stringify(reviewed)) as { outputs: Record<string, Record<string, { items: string[] }>> };
    tampered.outputs.ai.labels.items = ['door', 'door'];
    expect(() => parseCheckpoint(tampered)).toThrow(/do not match the proposal digest/);
  });

  it('refuses a claim after the graph or the sources changed', async () => {
    const checkpoint = await paused();
    const reviewed = approveCheckpoint(checkpoint, checkpoint.proposalDigest);
    expect(() => claimCheckpoint(reviewed, { ...claim('a'), graphDigest: 'changed' })).toThrow(expect.objectContaining({ code: 'graph-changed' }));
    expect(() => claimCheckpoint(reviewed, { ...claim('a'), sourceDigest: 'model-hash-2' })).toThrow(expect.objectContaining({ code: 'sources-changed' }));
  });

  it('lets exactly one of two concurrent claimers consume a reviewed checkpoint', async () => {
    const store = new MemoryCheckpointStore();
    const checkpoint = await paused();
    await store.write(approveCheckpoint(checkpoint, checkpoint.proposalDigest), null);
    const results = await Promise.allSettled([
      updateCheckpoint(store, checkpoint.id, (c) => claimCheckpoint(c, claim('tab-a'))),
      updateCheckpoint(store, checkpoint.id, (c) => claimCheckpoint(c, claim('tab-b'))),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ code: 'not-reviewed' });
    const owner = (await store.read(checkpoint.id))!.checkpoint.claim!.owner;
    const other = owner === 'tab-a' ? 'tab-b' : 'tab-a';
    expect(() => finishCheckpoint((results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<FlowCheckpoint>).value, other, { ok: true }))
      .toThrow(expect.objectContaining({ code: 'not-owner' }));
    const done = await updateCheckpoint(store, checkpoint.id, (c) => finishCheckpoint(c, owner, { ok: true }));
    expect(done.state).toBe('completed');
    await expect(updateCheckpoint(store, checkpoint.id, (c) => claimCheckpoint(c, claim('tab-c')))).rejects.toMatchObject({ code: 'not-reviewed' });
  });

  it('marks a failed resume and a lost owner as partially committed, never claimable again', async () => {
    const checkpoint = await paused();
    const applying = claimCheckpoint(approveCheckpoint(checkpoint, checkpoint.proposalDigest), claim('tab-a', 2_000));
    expect(finishCheckpoint(applying, 'tab-a', { ok: false, message: 'sink failed' })).toMatchObject({ state: 'partially-committed', outcome: { ok: false, message: 'sink failed' } });
    // Crash after claiming: before the lease runs out nothing changes; after it, the checkpoint is blocked.
    expect(recoverCheckpoint(applying, 2_000 + 30_000)).toBeNull();
    const recovered = recoverCheckpoint(applying, 2_000 + 60_001)!;
    expect(recovered.state).toBe('partially-committed');
    expect(() => claimCheckpoint(recovered, claim('tab-b', 70_000))).toThrow(expect.objectContaining({ code: 'not-reviewed' }));
    // Crash before claiming: a reviewed checkpoint is untouched by recovery and still claimable.
    const reviewed = approveCheckpoint(checkpoint, checkpoint.proposalDigest);
    expect(recoverCheckpoint(reviewed, 1e12)).toBeNull();
    expect(claimCheckpoint(reviewed, claim('tab-b')).state).toBe('applying');
  });
});

it('#7038 refuses a resume when a previously completed node now requires review', async () => {
  const checkpoint = await paused();
  const changed = new NodeRegistry<Host>().registerAll(registry.list().map(def =>
    def.type === 't.rows' ? { ...def, review: 'required' as const } : def));
  const reviewed = approveCheckpoint(checkpoint, checkpoint.proposalDigest);
  expect(() => claimCheckpoint(reviewed, { ...claim('owner'), graphDigest: graphDigest(doc, {}, changed) }))
    .toThrow(expect.objectContaining({ code: 'graph-changed' }));
});

it('#7038 rejects malformed ports outside the proposal and invalid claim metadata', async () => {
  const checkpoint = await paused();
  for (const data of [{ kind: 'group', branches: 5 }, { kind: 'list', items: 5 }, { kind: 'item' }, { kind: 'unknown', value: 1 }]) {
    expect(() => parseCheckpoint({ ...checkpoint, outputs: { ...checkpoint.outputs, rows: { t: data } } }))
      .toThrow(/malformed or non-portable/);
  }
  for (const claim of [{ owner: 42, leaseUntil: 3, at: 2 }, { owner: 'me', leaseUntil: '3', at: 2 }, { owner: 'me', leaseUntil: Infinity, at: 2 }]) {
    expect(() => parseCheckpoint({ ...checkpoint, claim })).toThrow(/invalid claim/);
  }
});

it('#7038 rejects cyclic checkpoint values instead of hanging during portability validation', async () => {
  const checkpoint = await paused();
  const value: { again?: unknown } = {};
  value.again = value;
  expect(() => parseCheckpoint({ ...checkpoint, outputs: { ...checkpoint.outputs, rows: { t: { kind: 'item', value } } } }))
    .toThrow(/malformed or non-portable/);
});


it('#7038 renaming a graph or node invalidates approval for its default write target', async () => {
  const checkpoint = await paused();
  const reviewed = approveCheckpoint(checkpoint, checkpoint.proposalDigest);
  const changedGraphs: FlowDocument[] = [
    { ...doc, name: 'different-target' },
    { ...doc, id: 'different-graph' },
    { ...doc, nodes: doc.nodes.map(node => node.id === 'sink' ? { ...node, label: 'different-target' } : node) },
  ];
  for (const changed of changedGraphs) {
    expect(() => claimCheckpoint(reviewed, { ...claim('owner'), graphDigest: graphDigest(changed, {}, registry) }))
      .toThrow(expect.objectContaining({ code: 'graph-changed' }));
  }
});


it('#7038 distinct runs at the same millisecond retain independent approvals', async () => {
  const first = await paused();
  const second = await paused();
  expect(first.createdAt).toBe(second.createdAt);
  expect(first.graphDigest).toBe(second.graphDigest);
  expect(first.proposalDigest).toBe(second.proposalDigest);
  expect(first.id).not.toBe(second.id);
  const store = new MemoryCheckpointStore();
  expect(await store.write(first, null)).toBe(true);
  expect(await store.write(second, null)).toBe(true);
  await updateCheckpoint(store, first.id, checkpoint => approveCheckpoint(checkpoint, first.proposalDigest));
  expect((await store.read(first.id))?.checkpoint.state).toBe('reviewed');
  expect((await store.read(second.id))?.checkpoint.state).toBe('prepared');
});

// #7038 portability and approval bind the values actually resumed.
it('#7038 rejects nonportable budgets and snapshots caller-owned values', async () => {
  const result = await runFlow(doc, { host: { sunk: [] }, registry });
  const prepared = await paused();
  for (const budget of [new Map([['spent', 2]]), Infinity, () => 2]) {
    expect(() => createCheckpoint({ doc, registry, result, sourceDigest: 'source', budget })).toThrow(/budget/);
    expect(() => parseCheckpoint({ ...prepared, budget })).toThrow(/budget/);
  }
  const budget = { requests: 2 };
  const checkpoint = createCheckpoint({ doc, registry, result, sourceDigest: 'source', budget });
  budget.requests = 9;
  const labels = result.outputs.get('ai')!.get('labels')!;
  if (labels.kind !== 'list') throw new Error('expected label list');
  (labels.items as string[])[0] = 'changed';
  expect(checkpoint.budget).toEqual({ requests: 2 });
  expect(checkpoint.outputs.ai.labels).toEqual({ kind: 'list', items: ['wall', 'unknown'] });
});

it('#7038 rejects proposal mutations during the in-memory approval lifecycle', async () => {
  const checkpoint = await paused();
  const reviewed = approveCheckpoint(checkpoint, checkpoint.proposalDigest);
  const labels = reviewed.outputs.ai.labels;
  if (labels.kind !== 'list') throw new Error('expected label list');
  (labels.items as string[])[0] = 'changed';
  expect(() => claimCheckpoint(reviewed, claim('owner'))).toThrow(/proposal digest/);
});

it('#7038 rejects invalid leases before claiming and permits recovery of valid claims', async () => {
  const checkpoint = await paused();
  const reviewed = approveCheckpoint(checkpoint, checkpoint.proposalDigest);
  for (const leaseMs of [Infinity, NaN, 0, -1]) {
    expect(() => claimCheckpoint(reviewed, { ...claim('owner'), leaseMs })).toThrow(/finite positive lease/);
  }
  expect(reviewed.state).toBe('reviewed');
  const applying = claimCheckpoint(reviewed, claim('owner'));
  expect(parseCheckpoint(JSON.parse(JSON.stringify(applying)))).toEqual(applying);
  expect(recoverCheckpoint(applying, applying.claim!.leaseUntil)?.state).toBe('partially-committed');
});

it('#7038 refuses duplicate portable group keys instead of dropping one branch', async () => {
  const checkpoint = await paused();
  expect(() => parseCheckpoint({ ...checkpoint, outputs: { ...checkpoint.outputs, rows: { t: { kind: 'group', branches: [['zone', [1]], ['zone', [2]]] } } } }))
    .toThrow(/malformed or non-portable/);
});

it('#7038 file-slot bindings are already included through Player input definitions', async () => {
  const checkpoint = await paused();
  const reviewed = approveCheckpoint(checkpoint, checkpoint.proposalDigest);
  const changed: FlowDocument = { ...doc, inputs: [{ nodeId: 'rows', param: 'sources', label: 'Files', kind: 'files',
    fileSlots: [{ id: 'models', label: 'Models', accept: '.ifc', multiple: true, required: true }] }] };
  expect(() => claimCheckpoint(reviewed, { ...claim('owner'), graphDigest: graphDigest(changed, {}, registry) }))
    .toThrow(expect.objectContaining({ code: 'graph-changed' }));
  expect(graphDigest(changed, {}, registry)).not.toBe(graphDigest({ ...changed, inputs: [{ ...changed.inputs[0], nodeId: 'sink' }] }, {}, registry));
});


it('#7038 approval also binds upstream outputs so removing a completed node cannot repeat it', async () => {
  const checkpoint = await paused();
  const reviewed = approveCheckpoint(checkpoint, checkpoint.proposalDigest);
  const outputs = Object.fromEntries(Object.entries(reviewed.outputs).filter(([node]) => node !== 'rows'));
  const missing = { ...reviewed, outputs };
  expect(() => parseCheckpoint(missing)).toThrow(/proposal digest/);
  expect(() => claimCheckpoint(missing, claim('owner'))).toThrow(/proposal digest/);
});

it('#7038 invalid lifecycle timestamps cannot approve, recover or finish a valid checkpoint', async () => {
  const checkpoint = await paused();
  const reviewed = approveCheckpoint(checkpoint, checkpoint.proposalDigest);
  const applying = claimCheckpoint(reviewed, claim('owner'));
  for (const now of [NaN, Infinity, -Infinity]) {
    expect(() => approveCheckpoint(checkpoint, checkpoint.proposalDigest, now)).toThrow(/timestamp must be finite/);
    expect(() => rejectCheckpoint(checkpoint, now)).toThrow(/timestamp must be finite/);
    expect(() => finishCheckpoint(applying, 'owner', { ok: true }, now)).toThrow(/timestamp must be finite/);
    expect(() => recoverCheckpoint(applying, now)).toThrow(/timestamp must be finite/);
  }
  expect(recoverCheckpoint(applying, applying.claim!.at)).toBeNull();
});


it('#7038 rejected, partial and expired checkpoints cannot supply downstream write inputs', async () => {
  const prepared = await paused();
  const reviewed = approveCheckpoint(prepared, prepared.proposalDigest, 1_500);
  const applying = claimCheckpoint(reviewed, claim('owner'));
  const partial = finishCheckpoint(applying, 'owner', { ok: false }, 3_000);
  for (const checkpoint of [prepared, reviewed, rejectCheckpoint(prepared, 1_500), partial,
    finishCheckpoint(applying, 'owner', { ok: true }, 3_000), applying]) {
    const host: Host = { sunk: [] };
    expect(() => resumeOutputs(checkpoint, 3_001)).toThrow(/actively claimed/);
    // Inspection remains possible, but its raw proposal map must reach and fail
    // the scheduler boundary before a sink can write (#7038).
    await expect(runFlow(doc, { host, registry, resume: checkpointProposal(checkpoint) }))
      .rejects.toThrow(/resume requires/);
    expect(host.sunk).toEqual([]);
  }
  expect(() => resumeOutputs(applying, 62_000)).toThrow(/actively claimed/);
  // Review inspection does not authorize a resume.
  expect([...checkpointProposal(prepared).keys()]).toEqual(['ai']);
});


it('#7038 prototype-named completed nodes and ports survive checkpoints without repeating writes', async () => {
  for (const special of ['__proto__', 'constructor', 'toString']) {
    let writes = 0;
    const ownRegistry = new NodeRegistry<Host>().registerAll([
      { type: 't.write', title: 'Write', category: 't', inputs: [], outputs: [{ name: special, type: table }],
        params: [], capabilities: [], writes: 'model',
        run: () => { writes++; return Object.fromEntries([[special, { columns: [], rows: [] }]]); } },
      registry.get('t.classify')!, registry.get('t.sink')!,
    ]);
    const graph: FlowDocument = { ...doc,
      nodes: [{ id: special, type: 't.write' }, { id: 'ai', type: 't.classify' }, { id: 'sink', type: 't.sink' }],
      edges: [{ from: [special, special], to: ['ai', 't'] }, { from: ['ai', 'labels'], to: ['sink', 'v'] }],
    };
    const host: Host = { sunk: [] };
    const paused = await runFlow(graph, { host, registry: ownRegistry });
    expect(writes).toBe(1);
    const checkpoint = parseCheckpoint(JSON.parse(JSON.stringify(createCheckpoint({ doc: graph, registry: ownRegistry, result: paused, sourceDigest: 'source' }))));
    expect(Object.hasOwn(checkpoint.outputs, special)).toBe(true);
    expect(Object.hasOwn(checkpoint.outputs[special], special)).toBe(true);
    const owned = await ownedClaim(approveCheckpoint(checkpoint, checkpoint.proposalDigest), {
      owner: 'owner', graphDigest: graphDigest(graph, {}, ownRegistry), sourceDigest: 'source', leaseMs: 60_000,
    });
    const completed = await runFlow(graph, { host, registry: ownRegistry, resume: resumeOutputs(owned) });
    expect(completed.ok).toBe(true);
    expect(writes).toBe(1);
    expect(host.sunk).toEqual([['wall', 'unknown']]);
  }
});

it('#7038 checkpoint creation cannot omit or replace the actual paused Player inputs', async () => {
  const inputs = { factor: 7 };
  const result = await runFlow(doc, { host: { sunk: [] }, registry, inputs });
  expect(() => createCheckpoint({ doc, registry, result, sourceDigest: 'source' })).toThrow(/actual paused run/);
  expect(() => createCheckpoint({ doc, registry, result, sourceDigest: 'source', inputs: { factor: 1 } })).toThrow(/actual paused run/);
  const checkpoint = createCheckpoint({ doc, registry, result, sourceDigest: 'source', inputs });
  expect(checkpoint.graphDigest).toBe(graphDigest(doc, { factor: 7 }, registry));
  inputs.factor = 1;
  expect(() => createCheckpoint({ doc, registry, result, sourceDigest: 'source', inputs })).toThrow(/actual paused run/);
});

it('#7038 empty owners are refused before persisting a claim', async () => {
  const checkpoint = await paused();
  const reviewed = approveCheckpoint(checkpoint, checkpoint.proposalDigest);
  for (const owner of ['', '   ']) {
    expect(() => claimCheckpoint(reviewed, claim(owner))).toThrow(/owner must be nonempty/);
    expect(() => parseCheckpoint({ ...claimCheckpoint(reviewed, claim('owner')), claim: { owner, leaseUntil: 10, at: 1 } })).toThrow(/invalid claim/);
  }
  expect(reviewed.state).toBe('reviewed');
});

it('#7038 async resumed children cannot change another restored proposal or its nested values', async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const ownRegistry = new NodeRegistry<Host>().registerAll([
    registry.get('t.rows')!, registry.get('t.classify')!, registry.get('t.sink')!,
    { type: 't.await', title: 'Await', category: 't', inputs: [{ name: 'v', type: { kind: 'scalar', access: 'list' } }],
      outputs: [], params: [], capabilities: [], run: async () => { entered(); await blocked; return {}; } },
  ]);
  const graph: FlowDocument = { ...doc, nodes: [doc.nodes[0], { id: 'a', type: 't.classify' },
    { id: 'wait', type: 't.await' }, { id: 'z', type: 't.classify' }, { id: 'sink', type: 't.sink' }],
    edges: [{ from: ['rows', 't'], to: ['a', 't'] }, { from: ['a', 'labels'], to: ['wait', 'v'] },
      { from: ['rows', 't'], to: ['z', 't'] }, { from: ['z', 'labels'], to: ['sink', 'v'] }],
  };
  const host: Host = { sunk: [] };
  const result = await runFlow(graph, { host, registry: ownRegistry });
  const prepared = createCheckpoint({ doc: graph, registry: ownRegistry, result, sourceDigest: 'source' });
  const owned = await ownedClaim(approveCheckpoint(prepared, prepared.proposalDigest), {
    owner: 'owner', graphDigest: graphDigest(graph, {}, ownRegistry), sourceDigest: 'source', leaseMs: 60_000,
  });
  const resume = resumeOutputs(owned);
  const completed = runFlow(graph, { host, registry: ownRegistry, resume });
  await started;
  const proposal = resume.get('z')!.get('labels')!;
  if (proposal.kind !== 'list') throw new Error('expected list');
  (proposal.items as string[])[0] = 'unreviewed nested value';
  resume.set('z', new Map([['labels', { kind: 'list', items: ['unreviewed replacement'] }]]));
  release();
  expect((await completed).ok).toBe(true);
  expect(host.sunk).toEqual([['wall', 'unknown']]);
});

// #7038: completed outputs must belong to the graph actually executed.
it('#7038 refuses an edited graph supplied with an original paused result', async () => {
  const result = await runFlow(doc, { host: { sunk: [] }, registry });
  const changed = { ...doc, nodes: doc.nodes.map(n => n.id === 'rows' ? { ...n, params: { revision: 'edited' } } : n) };
  expect(() => createCheckpoint({ doc: changed, registry, result, sourceDigest: 'source' })).toThrow(/actual paused run/);
});

it('#7038 cannot renew an expired real lease with its historical claim timestamp', async () => {
  const checkpoint = await paused();
  const owned = await ownedClaim(approveCheckpoint(checkpoint, checkpoint.proposalDigest), claim('owner', Date.now() - 60_001));
  expect(() => resumeOutputs(owned, owned.claim!.at)).toThrow(/actively claimed/);
});


it('#7039 refuses removal or inflation of the approved root budget', async () => {
  const result = await runFlow(doc, { host: { sunk: [] }, registry });
  const checkpoint = createCheckpoint({ doc, registry, result, sourceDigest: 'source', budget: { maxRequests: 2, requests: 1 } });
  const approved = approveCheckpoint(checkpoint, checkpoint.proposalDigest);
  const { budget: _budget, ...withoutBudget } = approved;
  for (const edited of [withoutBudget, { ...approved, budget: { maxRequests: 100, requests: 0 } }]) {
    expect(() => parseCheckpoint(JSON.parse(JSON.stringify(edited)))).toThrow(/proposal digest/);
    expect(() => claimCheckpoint(edited, { ...claim('owner', Date.now()), sourceDigest: 'source' })).toThrow();
  }
  expect(parseCheckpoint(JSON.parse(JSON.stringify(approved))).budget).toEqual({ maxRequests: 2, requests: 1 });
});

it('recovers old locks only for dead writers, keeping live and recent locks (lifecycle audit)', async () => {
  const { mkdtemp, mkdir, writeFile, utimes, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { FileCheckpointStore } = await import('./checkpoint-file.js');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const root = await mkdtemp(join(tmpdir(), 'checkpoint-lock-'));
  try {
    const path = join(root, 'review.json'), lock = `${path}.lock`;
    const checkpoint = await paused();
    const store = new FileCheckpointStore(path);
    await mkdir(lock);
    const owner = join(lock, await checkpointOwner(dead));
    await writeFile(owner, '');
    expect(await store.write(checkpoint, null)).toBe(false);
    const old = new Date(Date.now() - 120_000);
    await utimes(owner, old, old);
    expect(await store.write(checkpoint, null)).toBe(true);
    await mkdir(lock);
    const live = join(lock, await checkpointOwner(process.pid));
    await writeFile(live, ''); await utimes(live, old, old);
    expect(await store.write(checkpoint, 1)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('#9540 a delayed reaper cannot remove a replacement writer before its CAS', async () => {
  const { mkdtemp, mkdir, writeFile, utimes, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { FileCheckpointStore } = await import('./checkpoint-file.js');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const root = await mkdtemp(join(tmpdir(), 'checkpoint-race-'));
  let resumeReaper!: () => void, resumeWriter!: () => void;
  const reaperGate = new Promise<void>(resolve => { resumeReaper = resolve; });
  const writerGate = new Promise<void>(resolve => { resumeWriter = resolve; });
  let reaperEntered!: () => void, writerEntered!: () => void;
  const reaperReady = new Promise<void>(resolve => { reaperEntered = resolve; });
  const writerReady = new Promise<void>(resolve => { writerEntered = resolve; });
  let firstWrite: Promise<boolean> | undefined, secondWrite: Promise<boolean> | undefined;
  try {
    const path = join(root, 'review.json'), lock = `${path}.lock`, owner = await checkpointOwner(dead);
    await mkdir(lock); await writeFile(join(lock, owner), '');
    const old = new Date(Date.now() - 120_000); await utimes(join(lock, owner), old, old);
    const checkpoint = await paused(), first = new FileCheckpointStore(path), second = new FileCheckpointStore(path);
    const release = first['release'].bind(first);
    first['release'] = async (target, identity) => {
      if (target === lock && identity === owner) { reaperEntered(); await reaperGate; }
      return release(target, identity);
    };
    const load = second.load.bind(second);
    second.load = async () => { writerEntered(); await writerGate; return load(); };
    firstWrite = first.write(checkpoint, null); await reaperReady;
    secondWrite = second.write(checkpoint, null); await writerReady;
    resumeReaper();
    expect(await firstWrite).toBe(false);
    // The replacement owns the real critical section but has not published a
    // checkpoint yet. CAS alone cannot hide deletion of its live lock here.
    expect(await new FileCheckpointStore(path).write(checkpoint, null)).toBe(false);
    resumeWriter(); expect(await secondWrite).toBe(true);
  } finally {
    resumeReaper(); resumeWriter();
    await Promise.allSettled([firstWrite, secondWrite].filter((p): p is Promise<boolean> => p !== undefined));
    await rm(root, { recursive: true, force: true });
  }
});

it('reports ownerless legacy checkpoint locks instead of guessing liveness (lifecycle audit)', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { FileCheckpointStore } = await import('./checkpoint-file.js');
  const root = await mkdtemp(join(tmpdir(), 'checkpoint-legacy-'));
  try {
    const path = join(root, 'review.json'); await writeFile(`${path}.lock`, '');
    await expect(new FileCheckpointStore(path).write(await paused(), null)).rejects.toThrow('has no PID');
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function oldIdentityLock(overrides: Partial<import('./checkpoint-lock-owner.js').LockOwnerIdentity> = {}) {
  const fs = await import('node:fs/promises');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const { FileCheckpointStore } = await import('./checkpoint-file.js');
  const { readLockIdentity, lockOwnerName } = await import('./checkpoint-lock-owner.js');
  const root = await fs.mkdtemp(join(tmpdir(), 'checkpoint-identity-'));
  const path = join(root, 'review.json'), lock = `${path}.lock`, local = await readLockIdentity();
  const owner = lockOwnerName({ ...local, ...overrides });
  await fs.mkdir(lock); await fs.writeFile(join(lock, owner), '');
  const old = new Date(Date.now() - 120_000); await fs.utimes(join(lock, owner), old, old);
  return { fs, root, path, lock, local, owner, checkpoint: await paused(), store: new FileCheckpointStore(path),
    cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

for (const field of ['start', 'boot'] as const) {
  it(`#9540 identity retires a prior ${field} at a still-live reused PID`, async context => {
    const { readLockIdentity } = await import('./checkpoint-lock-owner.js');
    const local = await readLockIdentity();
    if (!local[field]) context.skip('Requires Linux procfs process/boot identity');
    const different = field === 'start' ? (local.start === '0' ? '1' : '0') : (local.boot === '0000000000000000' ? '1111111111111111' : '0000000000000000');
    const f = await oldIdentityLock(field === 'start' ? { start: different } : { boot: different });
    try { expect(await f.store.write(f.checkpoint, null)).toBe(true); }
    finally { await f.cleanup(); }
  });
}

it('#9540 identity refuses foreign-host liveness even when that PID is dead locally', async () => {
  const { spawnSync } = await import('node:child_process');
  const { readLockIdentity } = await import('./checkpoint-lock-owner.js');
  const local = await readLockIdentity();
  const f = await oldIdentityLock({ pid: spawnSync(process.execPath, ['-e', '']).pid, host: local.host === '0000000000000000' ? '1111111111111111' : '0000000000000000' });
  try {
    await expect(f.store.write(f.checkpoint, null)).rejects.toThrow('another host');
    expect(await f.fs.readdir(f.lock)).toContain(f.owner);
  } finally { await f.cleanup(); }
});

for (const missing of [{}, { start: null }, { boot: null }, { start: null, boot: null }]) {
  it(`#9540 identity preserves a live owner and diagnoses unknown capabilities ${JSON.stringify(missing)}`, async () => {
    const f = await oldIdentityLock(missing); const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await f.store.write(f.checkpoint, null)).toBe(false);
      expect(await f.fs.readdir(f.lock)).toContain(f.owner);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`live PID ${process.pid}`));
    } finally { warn.mockRestore(); await f.cleanup(); }
  });
}

it('#9540 identity diagnoses unrecognized or unsafe owner records without deleting them', async () => {
  const { join } = await import('node:path');
  const { lockOwnerName } = await import('./checkpoint-lock-owner.js');
  for (const unsafe of [false, true]) {
    const f = await oldIdentityLock();
    try {
      const name = unsafe ? lockOwnerName({ ...f.local, pid: Number.MAX_SAFE_INTEGER + 1 }) : 'unknown-owner';
      await f.fs.rename(join(f.lock, f.owner), join(f.lock, name));
      await expect(f.store.write(f.checkpoint, null)).rejects.toThrow('process identity');
      expect(await f.fs.readdir(f.lock)).toEqual([name]);
    } finally { await f.cleanup(); }
  }
});

it('#9540 orphan cleanup reaps only old retired local candidates, including an empty mkdir crash', async () => {
  const fs = await import('node:fs/promises'); const { join } = await import('node:path');
  const { tmpdir } = await import('node:os'); const { spawnSync } = await import('node:child_process');
  const { FileCheckpointStore } = await import('./checkpoint-file.js');
  const { readLockIdentity, lockOwnerName } = await import('./checkpoint-lock-owner.js');
  const root = await fs.mkdtemp(join(tmpdir(), 'checkpoint-orphan-'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const path = join(root, 'review.json'), local = await readLockIdentity();
    const dead = { ...local, pid: spawnSync(process.execPath, ['-e', '']).pid };
    const old = new Date(Date.now() - 120_000), future = new Date(Date.now() + 86_400_000);
    const names = [
      `review.json.lock.${lockOwnerName(dead)}`,
      `review.json.lock.${lockOwnerName(dead)}`,
      `review.json.lock.${lockOwnerName(local)}`,
      `review.json.lock.${lockOwnerName({ ...dead, host: local.host === '0000000000000000' ? '1111111111111111' : '0000000000000000' })}`,
      `review.json.lock!${lockOwnerName(dead)}`,
      `review.json.lock.${lockOwnerName(dead)}`,
      `review.json.lock.${lockOwnerName(dead)}`,
      'review.json.lock.unrecognized',
    ];
    for (let i = 0; i < names.length; i++) {
      const candidate = join(root, names[i]);
      if (i === 5) await fs.writeFile(candidate, 'not a candidate directory');
      else await fs.mkdir(candidate);
      if (i !== 1) await fs.utimes(candidate, i === 6 ? future : old, i === 6 ? future : old);
    }
    expect(await new FileCheckpointStore(path).write(await paused(), null)).toBe(true);
    const remaining = await fs.readdir(root);
    expect(remaining).not.toContain(names[0]);
    for (const name of names.slice(1)) expect(remaining).toContain(name);
  } finally { warn.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
});

async function checkpointOwner(pid: number): Promise<string> {
  const { readLockIdentity, lockOwnerName } = await import('./checkpoint-lock-owner.js');
  return lockOwnerName(await readLockIdentity(pid));
}
