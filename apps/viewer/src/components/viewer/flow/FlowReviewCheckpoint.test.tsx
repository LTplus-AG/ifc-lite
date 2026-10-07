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
import { type FlowDocument, type RunResult } from '@ifc-lite/flow';
import { createCheckpoint, type FlowCheckpoint } from '@ifc-lite/flow/checkpoint';
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

async function saved(graph: FlowDocument): Promise<FlowCheckpoint> {
  const result: RunResult = {
    ok: true, writes: 0, graphOutputs: [], log: [], review: ['roles'],
    reports: [{ nodeId: 'roles', status: 'review', durationMs: 1, lanes: 1, laneErrors: 0, missing: {}, warnings: [] }],
    outputs: new Map([['roles', new Map([
      ['table', { kind: 'item', value: { key: 'key', columns: [{ name: 'key', type: 'identifier' }, { name: 'label', type: 'label' }, { name: 'evidence', type: 'text' }, { name: 'outcome', type: 'enum' }], rows } }],
      ['coverage', { kind: 'item', value: { model: 'stand-in', rows: 30, requests: 2, classified: 30, unknown: 0, failed: 0, notSent: 0 } }],
    ])]]),
  };
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
