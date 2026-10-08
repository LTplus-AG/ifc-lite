/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runFlow, type FlowDocument, type NodeStatus, type RunResult } from '@ifc-lite/flow';
import { approveCheckpoint, claimCheckpoint, createCheckpoint, graphDigest, resumeOutputs, updateCheckpoint } from '@ifc-lite/flow/checkpoint';
import { createStandardRegistry } from '@ifc-lite/flow-nodes';
import { useViewerStore } from '@/store';
import { browserCheckpointStore } from '@/lib/flow/checkpoint-store';
import { captureEvidence } from '../evidence';

// #7084 invariant: a review-paused arithmetic graph is unfinished; replay evaluates only the downstream sum.
const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
async function paused() {
  let proposals = 0;
  const registry = createStandardRegistry().register({ type: 'test.reviewNumber', title: 'Reviewed number', category: 'test',
    inputs: [], outputs: [{ name: 'value', type: { kind: 'scalar', access: 'item' } }], params: [], capabilities: [], review: 'required',
    run: () => { proposals++; return { value: 7 }; } });
  const doc: FlowDocument = { flowVersion: 2, id: crypto.randomUUID(), name: 'Reviewed sum', capabilities: [], inputs: [],
    outputs: [{ nodeId: 'sum', port: 'result', label: 'Total' }],
    nodes: [{ id: 'proposal', type: 'test.reviewNumber' }, { id: 'five', type: 'core.number', params: { value: 5 } },
      { id: 'sum', type: 'core.math', params: { op: 'add' } }],
    edges: [{ from: ['proposal', 'value'], to: ['sum', 'a'] }, { from: ['five', 'value'], to: ['sum', 'b'] }] };
  const run = await runFlow(doc, { host: {}, registry });
  assert.equal(run.ok, true); assert.deepEqual(run.review, ['proposal']);
  return { doc, registry, run, proposals: () => proposals };
}
function summary(doc: FlowDocument, run: RunResult) {
  useViewerStore.setState({ flowDoc: doc, flowLastRun: run, flowLastError: null, flowLastRunWindow: null, flowRunWarnings: [], flowArtifacts: [] });
  return (JSON.parse(captureEvidence('flowRun').payload) as { evidence: { summary: {
    status: string; verdict: string; executedNodes: number; nodeStatusCounts: Record<NodeStatus, number>; writes: number;
  } } }).evidence.summary;
}

test('#7084 a native paused scheduler is described as awaiting review, never passed', async () => {
  const fixture = await paused();
  const evidence = summary(fixture.doc, fixture.run);
  assert.equal(evidence.verdict, 'review-required'); assert.equal(evidence.status, 'review-required');
  assert.equal(evidence.writes, 0); assert.equal(fixture.run.outputs.has('sum'), false);
});

test('#7084 every native review status has a finite total and paused nodes are not executed', async () => {
  const fixture = await paused(); const evidence = summary(fixture.doc, fixture.run);
  assert.deepEqual(evidence.nodeStatusCounts, { ok: 1, memo: 0, noop: 0, skipped: 0, error: 0, review: 1, paused: 1, restored: 0 });
  assert.equal(Object.values(evidence.nodeStatusCounts).reduce((total, count) => total + count, 0), fixture.run.reports.length);
  assert.equal(evidence.executedNodes, 2);
});

test('#7084 native digest-approved checkpoint replay counts restored nodes separately from the evaluated sum', async () => {
  const fixture = await paused(); const sourceDigest = 'reviewed-arithmetic-inputs';
  const checkpoint = createCheckpoint({ doc: fixture.doc, registry: fixture.registry, result: fixture.run, sourceDigest });
  assert.equal(await browserCheckpointStore.write(checkpoint, null), true);
  await updateCheckpoint(browserCheckpointStore, checkpoint.id, current => approveCheckpoint(current, checkpoint.proposalDigest));
  const claimed = await updateCheckpoint(browserCheckpointStore, checkpoint.id, current => claimCheckpoint(current, {
    owner: 'review-evidence-test', graphDigest: graphDigest(fixture.doc, {}, fixture.registry), sourceDigest, leaseMs: 60_000,
  }));
  const resumed = await runFlow(fixture.doc, { host: {}, registry: fixture.registry, resume: resumeOutputs(claimed) });
  const evidence = summary(fixture.doc, resumed);
  assert.equal(evidence.nodeStatusCounts.restored, 2); assert.equal(evidence.executedNodes, 1);
  assert.equal(evidence.verdict, 'passed'); assert.equal(evidence.nodeStatusCounts.paused, 0);
  assert.deepEqual(resumed.outputs.get('sum')?.get('result'), { kind: 'item', value: 12 });
  assert.equal(fixture.proposals(), 1, 'reviewed proposal was restored, not generated again');
});
