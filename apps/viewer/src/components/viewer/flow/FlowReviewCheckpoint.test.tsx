/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6923: the review card shows every row of the saved proposal, approves
// exactly the digest on screen before resuming, and a rejection never
// resumes. Rendered against the real IndexedDB checkpoint store.

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { NodeRegistry, runFlow, type FlowData, type FlowDocument } from '@ifc-lite/flow';
import { createCheckpoint, type FlowCheckpoint } from '@ifc-lite/flow/checkpoint';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { render, cleanup, click } from '@/test/render';
import { ensureFlowAiNodes, flowRegistry } from '@/lib/flow/runner';
import { browserCheckpointStore } from '@/lib/flow/checkpoint-store';
import { useFlowReview, viewerSourceDigest } from '@/lib/flow/review-session';
import { FlowReviewCheckpoint } from './FlowReviewCheckpoint';

afterEach(() => { cleanup(); useFlowReview.setState({ checkpoint: null, values: {}, busy: false, problem: null }); });

const doc = (id: string): FlowDocument => ({
  flowVersion: 2, id, name: 'Roles', capabilities: ['network.ai'], inputs: [], outputs: [],
  nodes: [{ id: 'roles', type: 'ai.classify' }, { id: 'apply', type: 'model.applyTable' }],
  edges: [{ from: ['roles', 'table'], to: ['apply', 'table'] }],
});
const rows = Array.from({ length: 30 }, (_, i) => ({ key: `g${i}`, label: i % 2 ? 'Partition' : 'Facade', evidence: 'Pset_WallCommon.IsExternal', outcome: 'classified' }));

async function saved(graph: FlowDocument, proposalRows = rows, proposalData?: FlowData): Promise<FlowCheckpoint> {
  const proposal = proposalData ?? { kind: 'item' as const, value: { key: 'key',
    columns: [{ name: 'key', type: 'identifier' }, { name: 'label', type: 'label' }, { name: 'evidence', type: 'text' }, { name: 'outcome', type: 'enum' }], rows: proposalRows } };
  // Recorded proposal data passes through a real paused scheduler and the real durable store.
  const registry = new NodeRegistry().registerAll([
    { type: 'ai.classify', title: 'Recorded classification', category: 'test', inputs: [],
      outputs: [{ name: 'table', type: { kind: 'table', access: proposal.kind === 'item' ? 'item' : proposal.kind } }, { name: 'coverage', type: { kind: 'scalar', access: 'item' } }],
      params: [], capabilities: [], review: 'required', run: () => ({
        table: proposal.kind === 'item' ? proposal.value : proposal.kind === 'list' ? proposal.items : proposal.branches,
        coverage: { model: 'stand-in', rows: proposalRows.length, requests: 2, classified: proposalRows.length, unknown: 0, failed: 0, notSent: 0 },
      }) },
    { type: 'model.applyTable', title: 'Paused write', category: 'test', inputs: [{ name: 'table', type: { kind: 'table', access: 'item' } }],
      outputs: [], params: [], capabilities: [], writes: 'model', run: () => assert.fail('the write must remain paused before approval') },
  ]);
  const result = await runFlow(graph, { registry, host: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.review, ['roles']);
  await ensureFlowAiNodes();
  const checkpoint = createCheckpoint({ registry: flowRegistry(), doc: graph, result, sourceDigest: viewerSourceDigest() });
  assert.equal(await browserCheckpointStore.write(checkpoint, null), true);
  return checkpoint;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

it('shows the whole proposal with its coverage and approves the shown digest before resuming', async () => {
  const graph = doc('card-approve');
  const checkpoint = await saved(graph);
  const resumed: FlowCheckpoint[] = [];
  const container = render(<FlowReviewCheckpoint doc={graph} onResume={async (c) => { resumed.push(c); }} />);
  await settle();
  const region = container.querySelector('section[data-flow-review]')!;
  const heading = container.querySelector(`#${CSS.escape(region.getAttribute('aria-labelledby')!)}`);
  assert.equal(heading?.textContent, 'Review AI proposal');
  assert.equal(region.querySelectorAll('tbody tr').length, 30, 'every row of the proposal is shown, not a glimpse');
  assert.match(region.textContent ?? '', /30 rows · 30 classified · 0 unknown · 0 failed · 0 not sent · 2 requests · model stand-in/);
  assert.match(region.textContent ?? '', /Nothing downstream has run/);
  const approve = [...region.querySelectorAll('button')].find((b) => b.textContent === 'Approve and resume')!;
  click(approve);
  await settle();
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].state, 'reviewed');
  assert.equal(resumed[0].review?.proposalDigest, checkpoint.proposalDigest);
  assert.equal((await browserCheckpointStore.read(checkpoint.id))?.checkpoint.state, 'reviewed');
});

it('rejects without resuming, and announces the outcome', async () => {
  const graph = doc('card-reject');
  await saved(graph);
  const resumed: FlowCheckpoint[] = [];
  const container = render(<FlowReviewCheckpoint doc={graph} onResume={async (c) => { resumed.push(c); }} />);
  await settle();
  click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Reject')!);
  await settle();
  assert.equal(resumed.length, 0);
  assert.equal(container.querySelector('output')?.textContent, 'Rejected. Nothing downstream of the proposal ran.');
  assert.equal([...container.querySelectorAll('button')].some((b) => b.textContent === 'Approve and resume'), false);
});


it('#7040 exposes row 501 of a saved proposal before approving its full digest', async () => {
  const graph = doc('card-large');
  const proposalRows = Array.from({ length: 501 }, (_, i) => ({ ...rows[0], key: `g${i}` }));
  const checkpoint = await saved(graph, proposalRows);
  const resumed: FlowCheckpoint[] = [];
  const container = render(<FlowReviewCheckpoint doc={graph} onResume={async c => { resumed.push(c); }} />);
  await settle();
  assert.equal(container.querySelectorAll('tbody tr').length, 501);
  assert.equal(container.querySelector('tbody tr:last-child td')?.textContent, 'g500');
  click([...container.querySelectorAll('button')].find(button => button.textContent === 'Approve and resume')!);
  await settle();
  assert.equal(resumed[0]?.review?.proposalDigest, checkpoint.proposalDigest);
});


it('#7040 grouped proposals show every branch and the full nested table evidence', async () => {
  const graph = doc('card-grouped');
  const longEvidence = 'Complete evidence beyond the old forty character object preview';
  const groups = new Map(Array.from({ length: 9 }, (_, i) => [`branch-${i}`, [{
    key: 'key', columns: [{ name: 'key', type: 'identifier' }, { name: 'evidence', type: 'text' }],
    rows: [{ key: `nested-${i}`, evidence: longEvidence }],
  }]]));
  await saved(graph, rows, { kind: 'group', branches: groups });
  const container = render(<FlowReviewCheckpoint doc={graph} onResume={async () => undefined} />);
  await settle();
  assert.equal(container.querySelectorAll('tbody tr').length, 9);
  assert.match(container.textContent ?? '', /branch-8/);
  assert.match(container.textContent ?? '', /nested-8/);
  assert.match(container.textContent ?? '', new RegExp(longEvidence));
});

it('#7040 unloading the active source refuses approval before marking the proposal reviewed', async () => {
  const initial = useViewerStore.getState();
  try {
    useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('source'), sourceContentHash: 'source-hash' }), activeModelId: 'source' });
    const graph = doc('card-unloaded-source');
    const checkpoint = await saved(graph);
    const resumed: FlowCheckpoint[] = [];
    const ui = render(<FlowReviewCheckpoint doc={graph} onResume={async c => { resumed.push(c); }} />);
    await settle();
    await act(async () => { useViewerStore.getState().clearAllModels(); useViewerStore.setState({ activeModelId: null }); });
    click([...ui.querySelectorAll('button')].find(b => b.textContent === 'Approve and resume')!);
    await settle();
    assert.equal(resumed.length, 0);
    assert.equal((await browserCheckpointStore.read(checkpoint.id))?.checkpoint.state, 'prepared');
    assert.equal(useFlowReview.getState().problem?.kind, 'refused');
    assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /model|source/i);
  } finally { useViewerStore.setState(initial, true); }
});
