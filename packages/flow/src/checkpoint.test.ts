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

import { describe, expect, it } from 'vitest';
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
    const resumed = await runFlow(doc, { host, registry, resume: resumeOutputs(await ownedClaim(approveCheckpoint(revived, revived.proposalDigest, 1_500), claim('owner')), 2_001) });
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
    finishCheckpoint(applying, 'owner', { ok: true }, 3_000)]) {
    const host: Host = { sunk: [] };
    expect(() => runFlow(doc, { host, registry, resume: resumeOutputs(checkpoint, 3_001) })).toThrow(/actively claimed/);
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
