/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6923 acceptance: the shipped AI example on the committed
 * `building-architecture.ifc` sample, through the viewer's own runner, AI
 * host (the Assistant's model via the request service and the hosted proxy
 * route), IndexedDB checkpoint store and review session. Only the provider
 * response is a stand-in, served as the proxy's SSE stream and computed from
 * the rows actually sent.
 *
 * Invariants: nothing is written before approval; the approved labels are
 * written and the resume sends no model request; the checkpoint is consumed
 * once; an edit after review refuses the resume; an owner lost mid-resume
 * leaves the checkpoint partially committed, never claimable.
 */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoCache, type FlowDocument, type Table } from '@ifc-lite/flow';
import { claimCheckpoint, graphDigest, resumeOutputs, type FlowCheckpoint } from '@ifc-lite/flow/checkpoint';
import type { LoadedModel } from '@ifc-lite/mcp';
import { useViewerStore } from '@/store';
import { openFlowSample } from '@/test/flow-sample-fixture';
import { activeTrackingPin } from '@/lib/assistant/flow-tracking';
import { useRequestReceipts } from '@/lib/llm/request-receipts';
import { viewerFlowAi } from './ai-host';
import { browserCheckpointStore } from './checkpoint-store';
import { flowExamples } from './examples';
import { NativeFlowRunner } from './native-runner';
import { approveReview, claimReview, finishReview, loadGraphReview, pauseForReview, rejectReview, useFlowReview } from './review-session';
import { flowRegistry, runFlowInViewer } from './runner';

const initial = useViewerStore.getState();
const originalFetch = globalThis.fetch;
let requests = 0;

/** The stand-in model behind the hosted proxy: labels a wall by its IsExternal cell and cites it. */
function serveProxy(): void {
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests += 1;
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const data = /<data>\n([\s\S]*)\n<\/data>/.exec(body.messages.at(-1)!.content)![1].split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const items = data.map((row) => ({ key: row.key, label: (row.values as Record<string, unknown>)['Pset_WallCommon.IsExternal'] === true ? 'Facade' : 'Partition', evidence: ['Pset_WallCommon.IsExternal'] }));
    const frames = [
      { choices: [{ delta: { content: JSON.stringify({ items }) }, finish_reason: null }] },
      { choices: [{ delta: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 60 } },
    ];
    return new Response(`${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
}

const claimVisibleReview = (doc: FlowDocument, inputs: Record<string, unknown>) =>
  claimReview(doc, inputs, useFlowReview.getState().checkpoint!.id);

const example = (): FlowDocument => ({ ...flowExamples().find((d) => d.id === 'example-ai-wall-roles')!, id: 'ai-roles-under-test' });
const roles = (model: LoadedModel) => ({
  facade: model.bim.query().byType('IfcWall').where('Pset_Coordination', 'WallRole', '=', 'Facade').count(),
  partition: model.bim.query().byType('IfcWall').where('Pset_Coordination', 'WallRole', '=', 'Partition').count(),
  external: model.bim.query().byType('IfcWall').where('Pset_WallCommon', 'IsExternal', '=', true).count(),
});

async function pausedRun(model: LoadedModel, doc: FlowDocument) {
  const ai = viewerFlowAi();
  assert.ok(ai, 'the Assistant model serves Flow AI nodes');
  const result = await runFlowInViewer({ doc, bim: model.bim, pin: activeTrackingPin()!, cache: new MemoCache(), ai: ai.service });
  await pauseForReview({ doc, result, inputs: {}, values: {}, budget: { ...ai.budget } });
  return result;
}

beforeEach(() => {
  requests = 0;
  serveProxy();
  useFlowReview.setState({ checkpoint: null, values: {}, busy: false, problem: null });
});

test('#7039 viewer resume refuses missing budget receipts before claiming downstream AI work', async () => {
  const model = await openFlowSample();
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-4o-mini' });
  const original = example();
  const doc: FlowDocument = { ...original, outputs: [], nodes: original.nodes.map(node => node.id === 'apply'
    ? { ...node, type: 'ai.classify', params: { ...original.nodes.find(n => n.id === 'roles')!.params, columns: ['label'] } }
    : node) };
  const ai = viewerFlowAi();
  assert.ok(ai);
  const result = await runFlowInViewer({ doc, bim: model.bim, pin: activeTrackingPin()!, cache: new MemoCache(), ai: ai.service });
  assert.deepEqual(result.review, ['roles']);
  assert.equal(requests, 1);
  for (const budget of [undefined, { maxRequests: 1 }]) {
    await pauseForReview({ doc, result, inputs: {}, values: {}, budget });
    const pending = useFlowReview.getState().checkpoint;
    assert.ok(pending);
    assert.equal((await approveReview(pending.proposalDigest, doc))?.state, 'reviewed');
    assert.equal(await claimVisibleReview(doc, {}), null);
    assert.equal(useFlowReview.getState().problem!.kind, 'refused');
    assert.match(useFlowReview.getState().problem!.message, /requires the original root budget receipt/);
    assert.equal((await browserCheckpointStore.read(pending.id))?.checkpoint.state, 'reviewed');
    assert.equal(requests, 1);
  }
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  useViewerStore.setState(initial, true);
  useRequestReceipts.setState({ receipts: [] });
  localStorage.clear();
});

test('#6923 the AI example pauses, writes nothing until approved, then resumes from the checkpoint without a model request', async () => {
  const model = await openFlowSample();
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-4o-mini' });
  const doc = example();

  const paused = await pausedRun(model, doc);
  assert.equal(paused.ok, true);
  assert.deepEqual(paused.review, ['roles']);
  assert.equal(paused.reports.find((r) => r.nodeId === 'apply')?.status, 'paused');
  assert.equal(requests, 1);
  assert.equal(useRequestReceipts.getState().receipts.length, 1, 'the AI request has a usage receipt in the session log');
  assert.deepEqual(roles(model), { facade: 0, partition: 0, external: roles(model).external }, 'nothing is written before approval');

  const pending = useFlowReview.getState().checkpoint!;
  assert.equal(pending.state, 'prepared');
  const stored = await browserCheckpointStore.read(pending.id);
  assert.equal(stored?.checkpoint.proposalDigest, pending.proposalDigest, 'the checkpoint is durable');
  assert.deepEqual(stored?.checkpoint.budget, { maxRequests: 12, maxOutputTokens: 24_000, requests: 1, outputTokens: 60 });
  const proposal = (stored!.checkpoint.outputs.roles.table as { value: Table }).value;
  assert.equal(proposal.rows.length, 4);

  assert.equal(await approveReview('not-what-was-shown', doc), null);
  assert.deepEqual(useFlowReview.getState().problem, { kind: 'refused', code: 'digest-mismatch', message: useFlowReview.getState().problem!.message });
  const approved = await approveReview(pending.proposalDigest, doc);
  assert.equal(approved?.state, 'reviewed');
  const claimed = await claimVisibleReview(doc, {});
  assert.equal(claimed?.state, 'applying');

  const replay = viewerFlowAi(claimed!.budget);
  const resumed = await runFlowInViewer({ doc, bim: model.bim, pin: activeTrackingPin()!, cache: new MemoCache(), ai: replay!.service, resume: resumeOutputs(claimed!) });
  await finishReview(resumed, undefined, claimed!);
  assert.equal(resumed.ok, true);
  assert.equal(requests, 1, 'the approved proposal is replayed, not requested again');
  assert.deepEqual(resumed.reports.map((r) => [r.nodeId, r.status]), [['walls', 'restored'], ['table', 'restored'], ['roles', 'restored'], ['apply', 'ok']]);
  const written = roles(model);
  assert.equal(written.facade + written.partition, 4);
  assert.equal(written.facade, written.external);
  assert.equal(useFlowReview.getState().checkpoint?.state, 'completed');

  assert.equal(await claimVisibleReview(doc, {}), null, 'a completed checkpoint is never claimed again');
  assert.equal(useFlowReview.getState().problem?.kind, 'refused');
});

test('#6923 an edit after review refuses the resume, and a rejected proposal ends the run', async () => {
  const model = await openFlowSample();
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-4o-mini' });
  const doc = example();
  await pausedRun(model, doc);
  await approveReview(useFlowReview.getState().checkpoint!.proposalDigest, doc);
  // A later edit (any pending mutation) changes the model state the proposal was made for.
  useViewerStore.setState({ undoStacks: new Map([['arch', [{ id: 'later-edit' } as never]]]) });
  assert.equal(await claimVisibleReview(doc, {}), null);
  assert.deepEqual(useFlowReview.getState().problem, { kind: 'refused', code: 'sources-changed', message: useFlowReview.getState().problem!.message });
  useViewerStore.setState({ undoStacks: new Map() });
  // A changed parameter is a different graph.
  const edited = { ...doc, nodes: doc.nodes.map((n) => (n.id === 'roles' ? { ...n, params: { ...n.params, maxRows: 10 } } : n)) };
  assert.equal(await claimVisibleReview(edited, {}), null);
  const refused = useFlowReview.getState().problem;
  assert.equal(refused?.kind === 'refused' ? refused.code : null, 'graph-changed');

  await pausedRun(model, doc);
  assert.equal((await rejectReview())?.state, 'rejected');
  assert.equal(await claimVisibleReview(doc, {}), null);
  assert.deepEqual(roles(model).facade + roles(model).partition, 0);
});

test('#6923 the same file reloaded under a new model id is the same source; another file is not', async () => {
  const model = await openFlowSample();
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-4o-mini' });
  const doc = example();
  await pausedRun(model, doc);
  await approveReview(useFlowReview.getState().checkpoint!.proposalDigest, doc);
  const loaded = useViewerStore.getState().models.get('arch')!;
  useViewerStore.setState({ models: new Map([['arch-other', { ...loaded, id: 'arch-other', sourceContentHash: 'another-file' }]]) });
  useViewerStore.getState().setActiveModel('arch-other');
  assert.equal(await claimVisibleReview(doc, {}), null);
  useViewerStore.setState({ models: new Map([['arch-reloaded', { ...loaded, id: 'arch-reloaded' }]]) });
  useViewerStore.getState().setActiveModel('arch-reloaded');
  assert.equal((await claimVisibleReview(doc, {}))?.state, 'applying');
});

test('#6923 a tab lost mid-resume leaves its checkpoint partially committed after the lease, never claimable', async () => {
  const model = await openFlowSample();
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-4o-mini' });
  const doc = example();
  await pausedRun(model, doc);
  const reviewed = (await approveReview(useFlowReview.getState().checkpoint!.proposalDigest, doc))!;
  // Another tab claimed it an hour ago and vanished.
  const stored = await browserCheckpointStore.read(reviewed.id);
  const lost = claimCheckpoint(reviewed, { owner: 'tab:gone', graphDigest: graphDigest(doc, {}, flowRegistry()), sourceDigest: reviewed.sourceDigest, leaseMs: 1, now: Date.now() - 3_600_000 });
  assert.equal(await browserCheckpointStore.write(lost, stored!.revision), true);
  await loadGraphReview(doc.id);
  const recovered = useFlowReview.getState().checkpoint!;
  assert.equal(recovered.state, 'partially-committed');
  assert.match(recovered.outcome?.message ?? '', /downstream effects may be partial/);
  assert.equal(await claimVisibleReview(doc, {}), null);
});

test('#6923 without a chosen model the AI nodes have no service and the run refuses before any request', async () => {
  const model = await openFlowSample();
  useViewerStore.setState({ chatActiveModel: 'llm-model-missing' });
  assert.equal(viewerFlowAi(), null);
  await assert.rejects(runFlowInViewer({ doc: example(), bim: model.bim, pin: activeTrackingPin()!, cache: new MemoCache() }), /roles: backend feature "ai" is not available/);
  assert.equal(requests, 0);
});


test('#7040 switching the active source among already loaded models invalidates the reviewed tracking pin', async () => {
  const model = await openFlowSample();
  const state = useViewerStore.getState();
  const loaded = state.models.get('arch')!;
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-4o-mini', models: new Map([
    ...state.models, ['second', { ...loaded, id: 'second', sourceContentHash: 'second-source-content' }],
  ]) });
  const doc = example();
  await pausedRun(model, doc);
  await approveReview(useFlowReview.getState().checkpoint!.proposalDigest, doc);
  useViewerStore.getState().setActiveModel('second');
  assert.equal(await claimVisibleReview(doc, {}), null);
  const problem = useFlowReview.getState().problem;
  assert.equal(problem?.kind === 'refused' ? problem.code : null, 'sources-changed');
  assert.equal(useFlowReview.getState().checkpoint?.state, 'reviewed', 'a refused source switch does not consume approval');
});


test('#7040 switching the Assistant model after review refuses the continuing AI run', async () => {
  const model = await openFlowSample();
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-4o-mini' });
  const doc = example();
  await pausedRun(model, doc);
  await approveReview(useFlowReview.getState().checkpoint!.proposalDigest, doc);
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-4o' });
  assert.equal(await claimVisibleReview(doc, {}), null);
  const problem = useFlowReview.getState().problem;
  assert.equal(problem?.kind === 'refused' ? problem.code : null, 'sources-changed');
  assert.equal(useFlowReview.getState().checkpoint?.state, 'reviewed');
  assert.equal(requests, 1, 'switching providers cannot send a continuing request');
});

test('#7040 switching between two loaded instances of identical IFC bytes refuses approval', async () => {
  const model = await openFlowSample();
  const state = useViewerStore.getState();
  const loaded = state.models.get('arch')!;
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-4o-mini', models: new Map([
    ...state.models, ['duplicate', { ...loaded, id: 'duplicate' }],
  ]) });
  const doc = example();
  await pausedRun(model, doc);
  await approveReview(useFlowReview.getState().checkpoint!.proposalDigest, doc);
  useViewerStore.getState().setActiveModel('duplicate');
  assert.equal(await claimVisibleReview(doc, {}), null);
  const problem = useFlowReview.getState().problem;
  assert.equal(problem?.kind === 'refused' ? problem.code : null, 'sources-changed');
  assert.equal(useFlowReview.getState().checkpoint?.state, 'reviewed');
});

test('#10591 resume claims and finalizes the requested checkpoint while another review is displayed', async () => {
  const model = await openFlowSample();
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-4o-mini' });
  const doc = example();
  await pausedRun(model, doc);
  const first = await approveReview(useFlowReview.getState().checkpoint!.proposalDigest, doc);
  assert.ok(first);
  await pausedRun(model, doc);
  const second = await approveReview(useFlowReview.getState().checkpoint!.proposalDigest, doc);
  assert.ok(second && second.id !== first.id);

  const claimed = await claimReview(doc, {}, first.id);
  assert.ok(claimed);
  assert.equal(claimed.id, first.id);
  const result = await runFlowInViewer({
    doc, bim: model.bim, pin: activeTrackingPin()!, cache: new MemoCache(),
    resume: resumeOutputs(claimed),
  });
  assert.equal(result.ok, true);
  assert.equal((await finishReview(result, undefined, claimed))?.id, first.id);
  assert.equal((await browserCheckpointStore.read(first.id))?.checkpoint.state, 'completed');
  assert.equal((await browserCheckpointStore.read(second.id))?.checkpoint.state, 'reviewed');
  assert.equal(useFlowReview.getState().checkpoint?.id, second.id);
});


for (const refusedWrites of [1, 2]) test(`#10591 a resumed flow with ${refusedWrites} refused finalization writes only retries the checkpoint`, async (t) => {
  const model = await openFlowSample();
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-4o-mini' });
  const doc = example();
  useViewerStore.getState().openContributedFlow(doc);
  await pausedRun(model, doc);
  const approved = await approveReview(useFlowReview.getState().checkpoint!.proposalDigest, doc);
  assert.ok(approved);
  const write = browserCheckpointStore.write.bind(browserCheckpointStore);
  let attempts = 0;
  t.mock.method(browserCheckpointStore, 'write', async (checkpoint: FlowCheckpoint, expected: number | null) => {
    if (checkpoint.id === approved.id && checkpoint.state === 'completed' && ++attempts <= refusedWrites) {
      throw new Error('Checkpoint storage is unavailable');
    }
    return write(checkpoint, expected);
  });

  const outcome = await new NativeFlowRunner(model.bim, async () => assert.fail('the graph needs no other model')).run({}, { resume: approved });
  const written = roles(model);
  assert.equal(written.facade + written.partition, 4, 'the resumed graph wrote its IFC changes');
  assert.equal(requests, 1, 'the approved proposal was reused without another assistant request');
  assert.equal(outcome.result?.ok, true);
  if (refusedWrites === 1) {
    assert.equal(outcome.state, 'completed');
    assert.equal((await browserCheckpointStore.read(approved.id))?.checkpoint.state, 'completed');
  } else {
    assert.equal(outcome.state, 'failed');
    assert.match(outcome.error ?? '', /effects may already exist.*checkpoint/i);
    assert.equal(useViewerStore.getState().flowLastRun, outcome.result);
    assert.equal((await browserCheckpointStore.read(approved.id))?.checkpoint.state, 'applying');
  }
  assert.equal(attempts, 2);
});

test('#10591 a cancelled pause does not replace another graph’s review when storage settles', async (t) => {
  const { deferred } = await import('@/test/race');
  const model = await openFlowSample();
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-4o-mini' });
  const doc = example();
  const other: FlowDocument = { ...doc, id: 'other-graph-in-review' };
  await pausedRun(model, other);
  const otherCheckpoint = useFlowReview.getState().checkpoint!;
  useViewerStore.getState().openContributedFlow(doc);
  const entered = deferred<string>(), settleWrite = deferred();
  const write = browserCheckpointStore.write.bind(browserCheckpointStore);
  t.mock.method(browserCheckpointStore, 'write', async (checkpoint: FlowCheckpoint, expected: number | null) => {
    if (checkpoint.graphId === doc.id && checkpoint.state === 'prepared') {
      entered.resolve(checkpoint.id);
      await settleWrite.promise;
    }
    return write(checkpoint, expected);
  });

  const run = new NativeFlowRunner(model.bim, async () => assert.fail('the graph needs no other model')).run();
  const pausedId = await entered.promise;
  useViewerStore.getState().openContributedFlow(other);
  await loadGraphReview(other.id);
  assert.equal(useFlowReview.getState().checkpoint?.id, otherCheckpoint.id);
  settleWrite.resolve();
  assert.equal((await run).state, 'cancelled');
  assert.equal((await browserCheckpointStore.read(pausedId))?.checkpoint.state, 'prepared');
  assert.equal(useFlowReview.getState().checkpoint?.id, otherCheckpoint.id);
});

test('#10591 a failed release preserves a review when no downstream work started', async (t) => {
  const { REVIEW_LEASE_MS } = await import('./review-session');
  const { fixtureModel } = await import('@/test/store-fixture');
  const model = await openFlowSample();
  const modelId = useViewerStore.getState().activeModelId!;
  useViewerStore.getState().addModel(fixtureModel('new-default', { idOffset: 1_000_000 }));
  useViewerStore.setState({ chatActiveModel: 'openai/gpt-4o-mini' });
  const doc = { ...example(), id: 'release-write-failure' };
  useViewerStore.getState().openContributedFlow(doc);
  await pausedRun(model, doc);
  const approved = await approveReview(useFlowReview.getState().checkpoint!.proposalDigest, doc);
  assert.ok(approved);

  const write = browserCheckpointStore.write.bind(browserCheckpointStore);
  let releaseAttempts = 0;
  const failRelease = t.mock.method(browserCheckpointStore, 'write', async (checkpoint: FlowCheckpoint, expected: number | null) => {
    if (checkpoint.state === 'applying') useViewerStore.getState().setActiveModel('new-default');
    if (checkpoint.state === 'reviewed') {
      releaseAttempts++;
      throw new Error('Checkpoint storage is unavailable');
    }
    return write(checkpoint, expected);
  });
  const outcome = await new NativeFlowRunner(model.bim, async () => assert.fail('the graph needs no other model'))
    .run({}, { resume: approved, expectedDefaultModelId: modelId });
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.error ?? '', /default model changed while claiming/);
  assert.equal(releaseAttempts, 1);
  const written = roles(model);
  assert.equal(written.facade + written.partition, 0);
  assert.equal((await browserCheckpointStore.read(approved.id))?.checkpoint.state, 'applying');

  failRelease.mock.restore();
  t.mock.timers.enable({ apis: ['Date'], now: new Date(Date.now() + REVIEW_LEASE_MS + 1) });
  useViewerStore.getState().setActiveModel(modelId);
  await loadGraphReview(doc.id);
  const recovered = useFlowReview.getState().checkpoint;
  assert.ok(recovered);
  assert.equal(recovered.id, approved.id);
  assert.equal(recovered.state, 'reviewed');
  assert.deepEqual(recovered.review, approved.review);
  const retry = await new NativeFlowRunner(model.bim, async () => assert.fail('the graph needs no other model'))
    .run({}, { resume: recovered, expectedDefaultModelId: modelId });
  assert.equal(retry.state, 'completed');
  assert.equal(retry.checkpoint?.id, approved.id);
  assert.equal(requests, 1);
});
