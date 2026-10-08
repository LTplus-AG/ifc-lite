/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Feed the activity journal from the job state the viewer already keeps
 * (U02, #6925). Nothing here runs a job or changes one; each recorder watches
 * the native running flag and records start, phase and the native outcome:
 *
 *   load    recorded per canonical load by modelLoadCanceller, independent of shared UI flags
 *   clash   native owned session, `clashRunning`/progress/error/result sequence; cancel uses that session
 *   ids     recorded by useIDS per native run, before its first progress update
 *   flow    `flowRunning`, `flowProgress`, `flowLastRun.ok`, `flowLastError`, the run's abort signal; cancel = `cancelWorkflowRun`
 *   ai      request-service in-flight entries and their receipts; cancel aborts the request
 *
 * A run that stops without an error and without a new result is recorded as
 * cancelled, never as completed. Cancellation is read from the SOURCE (the
 * load cancel counter, the Flow run's abort signal), so a job stopped from its
 * own panel, the status bar or the loading card is recorded the same as one
 * cancelled from the tray. Exports record themselves where they run
 * (`ExportDialogShell`, and `recordActivity` in the dialogs outside it).
 */

import { en } from '@/i18n/en';
import type { TranslationKey } from '@/i18n';
import type { ViewerState } from '@/store';
import { activeClashRunSession } from '@/hooks/analysisRunCancellation';
import { activeWorkflowSignal, cancelWorkflowRun } from '@/lib/flow/run-session';
import { useRequestReceipts, type UsageReceipt } from '@/lib/llm/request-receipts';
import {
  beginActivity, finishActivity, restoreActivityJournal, updateActivity, useActivityJournal, type ActivityJob,
} from './activity-journal';

interface ViewerStoreLike {
  getState(): ViewerState;
  subscribe(listener: (state: ViewerState, previous: ViewerState) => void): () => void;
}

export function isCataloguedKey(key: string): key is TranslationKey {
  return Object.hasOwn(en, key);
}

interface Watch<B> {
  running: (state: ViewerState) => boolean;
  start: (state: ViewerState) => { job: Parameters<typeof beginActivity>[0]; baseline: B };
  tick?: (state: ViewerState) => Pick<ActivityJob, 'phase' | 'progress' | 'subject'> & { cancel?: (() => void) | null };
  end: (state: ViewerState, baseline: B) =>
    { outcome: 'completed' | 'partial' | 'failed' | 'cancelled'; detail?: string };
}

function watch<B>(store: ViewerStoreLike, spec: Watch<B>): () => void {
  let current: { id: string; baseline: B } | null = null;
  const observe = (state: ViewerState) => {
    const running = spec.running(state);
    if (running && !current) {
      const { job, baseline } = spec.start(state);
      current = { id: beginActivity(job), baseline };
    }
    if (running && current && spec.tick) updateActivity(current.id, spec.tick(state));
    if (!running && current) {
      const { outcome, detail } = spec.end(state, current.baseline);
      finishActivity(current.id, outcome, detail ? { detail } : {});
      current = null;
    }
  };
  observe(store.getState());
  return store.subscribe((state) => observe(state));
}

function watchClash(store: ViewerStoreLike): () => void {
  return watch(store, {
    running: (s) => s.clashRunning,
    start: (s) => ({ job: { kind: 'check', title: 'activityTray.job.clash', panel: 'clash',
      subject: [...s.models.values()].map(model => model.name).join(', ') || undefined,
      cancel: activeClashRunSession()?.cancel }, baseline: { sequence: s.clashRunSeq, signal: activeClashRunSession()?.controller.signal } }),
    tick: (s) => (s.clashProgress && s.clashProgress.total > 0
      ? { progress: { done: s.clashProgress.done, total: s.clashProgress.total } }
      : {}),
    end: (s, { sequence, signal }) => signal?.aborted ? { outcome: 'cancelled' } : s.clashError
      ? { outcome: 'failed', detail: s.clashError }
      : { outcome: s.clashRunSeq > sequence ? 'completed' : 'cancelled' },
  });
}

function watchFlow(store: ViewerStoreLike): () => void {
  return watch(store, {
    running: (s) => s.flowRunning,
    start: (s) => ({
      job: { kind: 'flow', title: 'activityTray.job.flow', panel: 'flow', cancel: cancelWorkflowRun,
        ...(s.flowDoc?.name ? { subject: s.flowDoc.name } : {}) },
      // useFlowRunner starts the run session before it raises `flowRunning`.
      baseline: { lastRun: s.flowLastRun, signal: activeWorkflowSignal() },
    }),
    tick: (s) => (s.flowProgress ? { phase: s.flowProgress } : {}),
    end: (s, { lastRun, signal }) => {
      // Aborted by the Flow panel's Stop, the tray's Cancel, or a superseding change.
      if (signal?.aborted) return { outcome: 'cancelled' };
      if (s.flowLastError) return { outcome: 'failed', detail: s.flowLastError };
      if (s.flowLastRun && s.flowLastRun !== lastRun) return { outcome: s.flowLastRun.ok ? 'completed' : 'failed' };
      return { outcome: 'cancelled' };
    },
  });
}

const AI_OUTCOME: Record<UsageReceipt['outcome'], { outcome: 'completed' | 'partial' | 'failed' | 'cancelled'; detailKey?: TranslationKey }> = {
  completed: { outcome: 'completed' },
  truncated: { outcome: 'partial', detailKey: 'activityTray.ai.truncated' },
  cancelled: { outcome: 'cancelled' },
  timeout: { outcome: 'failed', detailKey: 'activityTray.ai.timeout' },
  error: { outcome: 'failed' },
};

function watchRequests(): () => void {
  const recorded = new Set<string>();
  const observe = ({ inFlight, receipts }: ReturnType<typeof useRequestReceipts.getState>) => {
    for (const request of inFlight) {
      if (recorded.has(request.id)) continue;
      recorded.add(request.id);
      beginActivity({ id: request.id, kind: 'ai', title: 'activityTray.job.ai', subject: request.model, panel: 'assistant',
        cancel: request.cancel }, request.startedAt);
    }
    for (const receipt of receipts) {
      if (!recorded.has(receipt.id)) continue;
      recorded.delete(receipt.id);
      const { outcome, detailKey } = AI_OUTCOME[receipt.outcome];
      finishActivity(receipt.id, outcome, detailKey ? { detailKey } : {}, receipt.finishedAt);
    }
  };
  observe(useRequestReceipts.getState());
  return useRequestReceipts.subscribe(observe);
}

let restored = false;

/**
 * Restore the tab's journal once per page (jobs cut off by a reload become
 * interrupted), then start every recorder. Returns the unsubscribe.
 */
export function startActivityRecorders(store: ViewerStoreLike): () => void {
  if (!restored) {
    restored = true;
    restoreActivityJournal(isCataloguedKey);
  }
  const stops = [watchClash(store), watchFlow(store), watchRequests()];
  return () => { for (const stop of stops) stop(); };
}

/** Test seam: forget the once-per-page restore. */
export function resetActivityRecordersForTest(): void {
  restored = false;
  useActivityJournal.setState({ jobs: [] });
}
