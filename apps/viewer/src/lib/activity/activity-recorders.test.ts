/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tray's recorders read native job state (U02, #6925). Invariant: a job
 * is recorded as completed only when its source published a NEW result; a
 * run that stops without an error and without one is cancelled, an error is
 * failed with the source's own message. Assistant requests go through the
 * real request service (stubbed SSE), so a tray Cancel aborts the actual
 * request.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ValidationProgress, ValidationReport } from '@ifc-lite/ids';
import { useViewerStore } from '@/store';
import { runModelRequest } from '@/lib/llm/request-service';
import { createRootBudget } from '@/lib/llm/root-budget';
import { useRequestReceipts } from '@/lib/llm/request-receipts';
import { cancelWorkflowRun, startWorkflowRun, type WorkflowRun } from '@/lib/flow/run-session';
import { installModelLoadCanceller } from '@/hooks/modelLoadCanceller';
import { fixtureModel } from '@/test/store-fixture';
import { selectLoadCanceller } from '@/store/slices/loadingSlice';
import { activityCanceller, restoreActivityJournal, updateActivity, useActivityJournal, type ActivityJob } from './activity-journal.js';
import { isCataloguedKey, resetActivityRecordersForTest, startActivityRecorders } from './activity-recorders.js';

const initial = useViewerStore.getState();
const originalFetch = globalThis.fetch;
let stop: () => void = () => {};
let flowRun: WorkflowRun | null = null;

beforeEach(() => {
  resetActivityRecordersForTest();
  stop = startActivityRecorders(useViewerStore);
});
afterEach(() => {
  stop();
  flowRun?.release();
  flowRun = null;
  sessionStorage.clear();
  useViewerStore.setState(initial, true);
  useRequestReceipts.setState({ receipts: [], inFlight: [] });
  globalThis.fetch = originalFetch;
});

const jobs = (): ActivityJob[] => useActivityJournal.getState().jobs;
const only = (): ActivityJob => {
  assert.equal(jobs().length, 1, JSON.stringify(jobs()));
  return jobs()[0];
};

describe('clash run recorder', () => {
  it('records progress, then completed only when a new result was published', () => {
    const store = useViewerStore.getState();
    useViewerStore.setState({ models: new Map([['m', { ...fixtureModel('m'), name: 'coordination.ifc' }]]) });
    store.setClashRunning(true);
    assert.equal(only().subject, 'coordination.ifc', '#6952 names the actual loaded input');
    store.setClashProgress({ phase: 'narrow', rule: 'hard-clash', done: 3, total: 10 });
    assert.deepEqual([only().outcome, only().panel, only().progress], ['running', 'clash', { done: 3, total: 10 }]);
    store.bumpClashRunSeq();
    store.setClashRunning(false);
    assert.equal(only().outcome, 'completed');
    assert.equal(only().progress, undefined, 'a finished job shows no live progress');
  });

  it('a run that stops without a result is cancelled, not completed', () => {
    useViewerStore.getState().setClashRunning(true);
    useViewerStore.getState().setClashRunning(false);
    assert.equal(only().outcome, 'cancelled');
  });

  it('a run that errors is failed with the source message', () => {
    useViewerStore.getState().setClashRunning(true);
    useViewerStore.getState().setClashError('No model geometry is loaded.');
    useViewerStore.getState().setClashRunning(false);
    assert.deepEqual([only().outcome, only().detail], ['failed', 'No model geometry is loaded.']);
  });
});

describe('validation, Flow and load recorders', () => {
  it('validation completes only with a new report', () => {
    const progress: ValidationProgress = { phase: 'validating', specificationIndex: 1, totalSpecifications: 4, entitiesProcessed: 0, totalEntities: 9, percentage: 30 };
    useViewerStore.setState({ idsLoading: true, idsProgress: progress });
    assert.deepEqual(only().progress, { done: 2, total: 4 });
    useViewerStore.setState({ idsLoading: false, idsProgress: null });
    assert.equal(only().outcome, 'cancelled', 'no report was produced');
    useViewerStore.setState({ idsLoading: true, idsProgress: progress });
    useViewerStore.setState({ idsLoading: false, idsProgress: null, idsValidationReport: { source: { kind: 'ids' } } as unknown as ValidationReport });
    assert.equal(jobs()[1].outcome, 'completed');
  });

  it('a Flow run cancelled from the tray is cancelled even though the runner reports an error', () => {
    flowRun = startWorkflowRun(); // as useFlowRunner does before it raises flowRunning
    useViewerStore.setState({ flowRunning: true, flowProgress: 'Running node 2 of 5' });
    assert.equal(only().phase, 'Running node 2 of 5');
    const cancel = activityCanceller(only().id);
    assert.ok(cancel, 'Flow runs can be cancelled from the tray');
    cancel();
    assert.equal(flowRun.controller.signal.aborted, true, 'tray Cancel aborts the real run');
    useViewerStore.setState({ flowRunning: false, flowLastError: 'Workflow cancelled or superseded' });
    assert.equal(only().outcome, 'cancelled');
    assert.equal(only().phase, undefined, 'the last live phase is not shown as the outcome');
  });

  it('a Flow run stopped from the Flow panel is cancelled, not failed (PR #6952 review)', () => {
    flowRun = startWorkflowRun();
    useViewerStore.setState({ flowRunning: true });
    cancelWorkflowRun(); // FlowPlayer's Stop: useFlowRunner().cancel
    useViewerStore.setState({ flowRunning: false, flowLastError: 'Workflow cancelled or superseded' });
    assert.equal(only().outcome, 'cancelled');
  });

  it('a Flow run that errors on its own is failed', () => {
    flowRun = startWorkflowRun();
    useViewerStore.setState({ flowRunning: true });
    useViewerStore.setState({ flowRunning: false, flowLastError: 'Node 3 threw' });
    assert.deepEqual([only().outcome, only().detail], ['failed', 'Node 3 threw']);
  });

  it('#6952 concurrent federated loads have independent cancellation and completion', () => {
    let firstCancelled = 0;
    let secondCancelled = 0;
    const first = fixtureModel('first');
    const releaseFirst = installModelLoadCanceller('federated', () => { firstCancelled++; }, () => null, {
      subject: 'first.ifc', result: () => ({ outcome: useViewerStore.getState().models.has(first.id) ? 'completed' : 'cancelled' }),
    });
    useViewerStore.setState({ loading: true });
    const releaseSecond = installModelLoadCanceller('federated', () => { secondCancelled++; }, () => null, {
      subject: 'second.ifc', result: () => ({ outcome: 'cancelled' }),
    });
    assert.deepEqual(jobs().map(job => [job.subject, job.outcome]), [['first.ifc', 'running'], ['second.ifc', 'running']]);
    // StatusBar Cancel ends the latest add, not its independent predecessor.
    selectLoadCanceller(useViewerStore.getState())!();
    assert.equal(secondCancelled, 1);
    assert.equal(firstCancelled, 0);
    assert.deepEqual(jobs().map(job => job.outcome), ['running', 'cancelled']);
    assert.ok(activityCanceller(jobs()[0].id), 'the earlier load keeps its own Cancel');
    useViewerStore.setState({ loading: false, models: new Map([[first.id, first]]) });
    assert.equal(jobs()[0].outcome, 'running', 'shared loading flags cannot settle this file');
    releaseFirst();
    releaseSecond();
    assert.deepEqual(jobs().map(job => job.outcome), ['completed', 'cancelled']);
  });

  it('#6952 cancelling an earlier add does not cancel or clear the latest load UI', () => {
    let firstCancelled = 0;
    let secondCancelled = 0;
    const releaseFirst = installModelLoadCanceller('federated', () => { firstCancelled++; }, () => null, {
      subject: 'first.ifc', result: () => ({ outcome: 'cancelled' }),
    });
    const second = fixtureModel('second');
    const releaseSecond = installModelLoadCanceller('federated', () => { secondCancelled++; }, () => null, {
      subject: 'second.ifc', result: () => ({ outcome: useViewerStore.getState().models.has(second.id) ? 'completed' : 'cancelled' }),
    });
    useViewerStore.setState({ loading: true, loadingFileName: 'second.ifc' });
    activityCanceller(jobs()[0].id)!();
    assert.equal(firstCancelled, 1);
    assert.equal(secondCancelled, 0);
    assert.equal(useViewerStore.getState().loading, true);
    assert.equal(useViewerStore.getState().loadingFileName, 'second.ifc');
    useViewerStore.setState({ models: new Map([[second.id, second]]) });
    releaseFirst();
    releaseSecond();
    assert.deepEqual(jobs().map(job => job.outcome), ['cancelled', 'completed']);
  });

  it('#6952 late subject persistence never restores an active phase after reload', () => {
    const release = installModelLoadCanceller('primary', () => {}, () => null, {
      subject: 'initial.ifc', result: () => ({ outcome: 'cancelled' }),
    });
    useViewerStore.getState().setProgress({ phase: 'Parsing', percent: 20 });
    updateActivity(only().id, { phase: 'Parsing', subject: 'late.ifc' });
    useActivityJournal.setState({ jobs: [] });
    restoreActivityJournal(isCataloguedKey);
    assert.deepEqual([only().subject, only().outcome, only().phase, only().progress], ['late.ifc', 'interrupted', undefined, undefined]);
    release();
  });

});

describe('assistant request recorder', () => {
  /** An SSE stream that sends one chunk and then waits until the request is aborted. */
  function hangingStream(): void {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`));
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;
  }

  it('shows the request while it runs; tray Cancel aborts the real request', async () => {
    hangingStream();
    const pending = runModelRequest({
      route: { kind: 'proxy', model: 'openai/gpt-free' }, proxyUrl: '/api/chat', messages: [{ role: 'user', content: 'Explain' }],
      maxOutputTokens: 512, budget: createRootBudget(), timeoutMs: 10_000,
    });
    assert.deepEqual([only().kind, only().outcome, only().subject], ['ai', 'running', 'openai/gpt-free']);
    activityCanceller(only().id)!();
    const outcome = await pending;
    assert.equal(outcome.kind, 'cancelled', 'the caller sees a cancelled request');
    assert.equal(only().outcome, 'cancelled');
    assert.equal(useRequestReceipts.getState().inFlight.length, 0, 'the receipt retires the in-flight entry');
  });

  it('a truncated answer is partial with its reason', async () => {
    globalThis.fetch = (async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Long' }, finish_reason: 'length' }] })}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    )) as typeof fetch;
    await runModelRequest({
      route: { kind: 'proxy', model: 'openai/gpt-free' }, proxyUrl: '/api/chat', messages: [{ role: 'user', content: 'Explain' }],
      maxOutputTokens: 512, budget: createRootBudget(), timeoutMs: 10_000,
    });
    assert.deepEqual([only().outcome, only().detailKey], ['partial', 'activityTray.ai.truncated']);
  });
});
