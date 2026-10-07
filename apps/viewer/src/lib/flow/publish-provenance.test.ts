/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FLOW_VERSION, NodeRegistry, runFlow, type FlowDocument, type NodeReport, type RunResult } from '@ifc-lite/flow';
import { createCheckpoint, approveCheckpoint, claimCheckpoint, updateCheckpoint, graphDigest, resumeOutputs, type CheckpointStore, type StoredCheckpoint } from '@ifc-lite/flow/checkpoint';
import { createStandardRegistry } from '@ifc-lite/flow-nodes';
import { flowPublishEligibility, flowPublishIntent, writingNodes, FLOW_PUBLISH_AUTHOR_KIND, mutationsInRun, countPendingOutsideRun } from './publish-provenance.js';
import { newFlowDocument } from './persistence.js';
import { addNode, setTracking } from './editor-ops.js';

const registry = createStandardRegistry();

function report(nodeId: string, status: NodeReport['status']): NodeReport {
  return { nodeId, status, durationMs: 0, lanes: 1, laneErrors: 0, missing: {}, warnings: [] };
}

function runResult(overrides: Partial<RunResult>): RunResult {
  return { ok: true, writes: 0, outputs: new Map(), graphOutputs: [], reports: [], log: [], review: [], ...overrides };
}

describe('flowPublishEligibility', () => {
  it('disabled with a reason before any run', () => {
    const e = flowPublishEligibility(null, null);
    assert.equal(e.canPublish, false);
    assert.equal(e.reason, 'flowPanel.publish.reason.noRun');
  });

  it('disabled with a reason after a failed run', () => {
    const e = flowPublishEligibility(runResult({ ok: false }), 'boom');
    assert.equal(e.canPublish, false);
    assert.equal(e.reason, 'flowPanel.publish.reason.failed');
  });

  it('disabled with a reason after a run that wrote nothing', () => {
    const e = flowPublishEligibility(runResult({ ok: true, writes: 0 }), null);
    assert.equal(e.canPublish, false);
    assert.equal(e.reason, 'flowPanel.publish.reason.noWrites');
  });

  it('enabled after a successful run that wrote', () => {
    const e = flowPublishEligibility(runResult({ ok: true, writes: 2 }), null);
    assert.equal(e.canPublish, true);
    assert.equal(e.reason, undefined);
  });
});

describe('writingNodes', () => {
  function graphWithWriter(): FlowDocument {
    let doc = newFlowDocument('publish-test');
    doc = addNode(doc, 'model.setProperty', [0, 0]).doc; // setProperty-1: writes: 'model'
    doc = addNode(doc, 'core.number', [0, 100]).doc; // number-1: no writes
    doc = setTracking(doc, 'setProperty-1', 'update', 'my-graph/rooms');
    return doc;
  }

  it('names only the write nodes whose report status is ok, by their tracking key', () => {
    const doc = graphWithWriter();
    const result = runResult({
      ok: true,
      writes: 1,
      reports: [report('setProperty-1', 'ok'), report('number-1', 'ok')],
    });
    const nodes = writingNodes(doc, registry, result);
    assert.deepEqual(nodes, [{ nodeId: 'setProperty-1', trackingKey: 'my-graph/rooms' }]);
  });

  it('excludes a write node whose report is missing or errored', () => {
    const doc = graphWithWriter();
    const result = runResult({ ok: false, writes: 0, reports: [report('setProperty-1', 'error')] });
    assert.deepEqual(writingNodes(doc, registry, result), []);
  });

  it('falls back to the node id when no tracking key or label is set', () => {
    let doc = newFlowDocument('untracked');
    doc = addNode(doc, 'model.setProperty', [0, 0]).doc;
    const result = runResult({ ok: true, writes: 1, reports: [report('setProperty-1', 'ok')] });
    assert.deepEqual(writingNodes(doc, registry, result), [{ nodeId: 'setProperty-1', trackingKey: 'setProperty-1' }]);
  });
});

describe('flowPublishIntent', () => {
  it('names the graph and the tracking keys of the nodes that wrote', () => {
    const doc = newFlowDocument('Audit rooms');
    const intent = flowPublishIntent(doc, [{ nodeId: 'a', trackingKey: 'graph/rooms' }, { nodeId: 'b', trackingKey: 'graph/doors' }]);
    assert.match(intent, /Audit rooms/);
    assert.match(intent, /graph\/rooms/);
    assert.match(intent, /graph\/doors/);
  });
});

describe('mutationsInRun — what one run published', () => {
  it('keeps exactly the mutations the run created, by id, even against a same-millisecond manual edit', () => {
    // An inclusive time window took in a manual edit stamped with the run's
    // end millisecond (#5380 review); ids cannot collide that way.
    const run = { mutationIds: new Set(['r1', 'r2']) };
    const pending = [
      { id: 'before', timestamp: 99 }, { id: 'r1', timestamp: 150 },
      { id: 'r2', timestamp: 200 }, { id: 'manual', timestamp: 200 },
    ];
    assert.deepEqual(mutationsInRun(pending, run).map((m) => m.id), ['r1', 'r2']);
  });
});

describe('FLOW_PUBLISH_AUTHOR_KIND', () => {
  it('is hybrid — a human steering a tool, per 03-provenance.md', () => {
    assert.equal(FLOW_PUBLISH_AUTHOR_KIND, 'hybrid');
  });
});

describe('flowPublishEligibility — other pending edits (#5380 review)', () => {
  const run = { ok: true, writes: 2, outputs: new Map(), graphOutputs: [], reports: [], log: [], review: [] } satisfies RunResult;

  it('blocks Publish while edits outside the run are pending, so clearing cannot lose them', () => {
    // Publish clears the pending set after moving the run's edits into a
    // layer. With a manual edit also pending, that clear would discard it.
    assert.deepEqual(flowPublishEligibility(run, null, 1), {
      canPublish: false, reason: 'flowPanel.publish.reason.otherEdits',
    });
    assert.deepEqual(flowPublishEligibility(run, null, 0), { canPublish: true });
  });

  it('blocks a second Publish once none of the run\'s edits is pending any more', () => {
    // A successful publish clears the run's edits (as does undoing them); a
    // second click would publish an empty layer (#5380 review).
    assert.deepEqual(flowPublishEligibility(run, null, 0, 0), {
      canPublish: false, reason: 'flowPanel.publish.reason.nothingPending',
    });
    assert.deepEqual(flowPublishEligibility(run, null, 0, 2), { canPublish: true });
  });

  it('counts edits the run did not make, on any model, plus pending georeferencing', () => {
    const edits = [{ id: 'a' }, { id: 'run' }, { id: 'b' }];
    const run = { mutationIds: new Set(['run']) };
    assert.equal(countPendingOutsideRun(edits, run, 0), 2);
    assert.equal(countPendingOutsideRun(edits, run, 1), 3, 'a pending georef change counts too');
    assert.equal(countPendingOutsideRun(edits, null, 0), 3, 'no recorded run: nothing belongs to it');
  });
});

// #7038: a successful paused run may have upstream writes, but cannot publish them yet.
it('blocks native paused writes until the required checkpoint is reviewed and the graph finishes', async () => {
  let writes = 0;
  const scalar = { kind: 'scalar', access: 'item' } as const;
  const native = new NodeRegistry().registerAll([
    { type: 'test.write', title: 'Write', category: 'test', inputs: [], outputs: [{ name: 'value', type: scalar }],
      params: [], capabilities: [], writes: 'model', run: () => { writes++; return { value: 7 }; } },
    { type: 'test.review', title: 'Review', category: 'test', inputs: [{ name: 'value', type: scalar }],
      outputs: [{ name: 'value', type: scalar }], params: [], capabilities: [], review: 'required',
      run: (_ctx, inputs) => ({ value: inputs.value }) },
    { type: 'test.finish', title: 'Finish', category: 'test', inputs: [{ name: 'value', type: scalar }],
      outputs: [], params: [], capabilities: [], run: () => ({}) },
  ]);
  const doc: FlowDocument = { flowVersion: FLOW_VERSION, id: 'review-publish', name: 'Review before publish',
    capabilities: [], inputs: [], outputs: [], nodes: [
      { id: 'write', type: 'test.write' }, { id: 'review', type: 'test.review' }, { id: 'finish', type: 'test.finish' },
    ], edges: [{ from: ['write', 'value'], to: ['review', 'value'] }, { from: ['review', 'value'], to: ['finish', 'value'] }] };
  const paused = await runFlow(doc, { registry: native, host: {} });
  assert.equal(paused.ok, true);
  assert.equal(paused.writes, 1);
  assert.deepEqual(flowPublishEligibility(paused, null), { canPublish: false, reason: 'flowPanel.publish.reason.review' });
  const checkpoint = createCheckpoint({ doc, registry: native, result: paused, sourceDigest: 'source' });
  const rows = new Map<string, StoredCheckpoint>();
  const store: CheckpointStore = {
    async read(id) { return structuredClone(rows.get(id) ?? null); },
    async write(value, expected) {
      const current = rows.get(value.id);
      if ((current?.revision ?? null) !== expected) return false;
      rows.set(value.id, { checkpoint: structuredClone(value), revision: (current?.revision ?? 0) + 1 });
      return true;
    },
  };
  await store.write(approveCheckpoint(checkpoint, checkpoint.proposalDigest), null);
  const claimed = await updateCheckpoint(store, checkpoint.id, current => claimCheckpoint(current, {
    owner: 'publish-test', graphDigest: graphDigest(doc, {}, native), sourceDigest: 'source', leaseMs: 60_000,
  }));
  const resumed = await runFlow(doc, { registry: native, host: {}, resume: resumeOutputs(claimed) });
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.review, []);
  assert.equal(writes, 1, 'resume does not repeat the upstream write');
  assert.equal(resumed.writes, 0, 'the resumed tail is read-only');
  const earlierWriters = writingNodes(doc, native, paused);
  assert.deepEqual(earlierWriters, [{ nodeId: 'write', trackingKey: 'write' }]);
  assert.deepEqual(flowPublishEligibility(resumed, null, 0, 1, earlierWriters.length), { canPublish: true });
  assert.deepEqual(writingNodes(doc, native, resumed, earlierWriters), earlierWriters, 'publish retains the completed writer provenance');
});

it('#7038 failure takes precedence over an independent pending review', () => {
  assert.deepEqual(flowPublishEligibility(runResult({ ok: false, writes: 1, review: ['proposal'] }), null),
    { canPublish: false, reason: 'flowPanel.publish.reason.failed' });
});
