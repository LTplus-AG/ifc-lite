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
import { ACTIVITY_STORAGE_KEY, activityCanceller, useActivityJournal, type ActivityJob } from './activity-journal.js';
import { resetActivityRecordersForTest, startActivityRecorders } from './activity-recorders.js';

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
    store.setClashRunning(true);
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

  it('a model load records the file and its failure', () => {
    let cancelled = 0;
    // The loading flag flips before the file name lands, as in the real loader.
    useViewerStore.setState({ loading: true, activeLoadCanceller: () => { cancelled++; } });
    useViewerStore.setState({ loadingFileName: 'AC20-FZK-Haus.ifc' });
    assert.deepEqual([only().subject, only().panel], ['AC20-FZK-Haus.ifc', 'loadReport']);
    assert.match(sessionStorage.getItem(ACTIVITY_STORAGE_KEY) ?? '', /AC20-FZK-Haus\.ifc/, 'a reload would still name the file');
    activityCanceller(only().id)?.();
    assert.equal(cancelled, 1, 'tray Cancel calls the load UI\'s own canceller');
    useViewerStore.setState({ loading: false, error: 'Unsupported schema' });
    assert.deepEqual([only().outcome, only().detail], ['failed', 'Unsupported schema']);
  });

  it('#6952 a load that stops without a new result is cancelled', () => {
    useViewerStore.setState({ loading: true });
    useViewerStore.setState({ loading: false });
    assert.equal(only().outcome, 'cancelled');
  });

  it('#6952 a newly published model completes a load and a late canceller reaches the tray', () => {
    useViewerStore.setState({ loading: true });
    assert.equal(activityCanceller(only().id), null);
    let cancels = 0;
    installModelLoadCanceller('primary', () => { cancels++; });
    assert.ok(activityCanceller(only().id));
    activityCanceller(only().id)!();
    assert.equal(cancels, 1);
    assert.equal(only().outcome, 'cancelled');
    useViewerStore.setState({ loading: true });
    const model = fixtureModel('new');
    useViewerStore.setState({ loading: false, models: new Map([[model.id, model]]) });
    assert.equal(jobs()[1].outcome, 'completed');
  });

  for (const kind of ['primary', 'federated'] as const) {
    it(`a ${kind} load cancelled from the status bar or loading card is cancelled, not completed (PR #6952 review)`, () => {
      useViewerStore.setState({ loading: true, loadingFileName: 'AC20-FZK-Haus.ifc' });
      installModelLoadCanceller(kind, () => {});
      // StatusBar's and ViewportLoadingCard's Cancel: the load UI's own canceller, not the tray's.
      selectLoadCanceller(useViewerStore.getState())!();
      assert.equal(useViewerStore.getState().loading, false, 'the real canceller ended the load');
      assert.equal(only().outcome, 'cancelled');
    });
  }
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
