/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Work that no load waits for, run after THE MODEL IT IS FOR has settled, in an
 * idle period, one job at a time in a fixed order. The one place that decides
 * when post-load work runs: the scene snapshot write, the symbolic overlay
 * parse, source compaction and the tier-1 search index.
 *
 * Settled (`modelLoadSettled`, the single definition): the model's record is
 * not in a load phase (`pending`, `streaming-geometry`, `hydrating-metadata`:
 * the phases streaming-refresh.ts and drawingPersistenceKey.ts treat as
 * loading), the primary geometry stream is not running for it, and none of its
 * instanced shards wait in the upload queue (`hasPendingInstancedShards`, the
 * rule #9628's readiness checks use; the queue's drain re-checks). A
 * store with no model record (the legacy single-model path) is settled when no
 * load and no stream are in progress. Another model's load never holds a
 * settled model's work back.
 *
 * Lifetime: a job is bound to its model's record. It is dropped, with every
 * reference it holds, when that record leaves `models` or its data store is
 * replaced (removal, a reload, a session reset). Its `signal` aborts then,
 * also when its work has already started and has not finished.
 *
 * Order: when several jobs are ready, the earliest `AfterLoadJob` starts first,
 * each in its own idle period. A job that returns a promise holds the next one
 * back until it settles (the snapshot write's sliced encode, the overlay parse);
 * one that returns nothing does not (compaction runs in a worker; the tier-1
 * build yields per chunk and can take seconds on a large model). The snapshot
 * write goes first because it decides whether the next reopen is fast. A job
 * holds the queue for 15 s at most; past that, later jobs start
 * while it finishes, so one slow or stuck job cannot hold every model back.
 *
 * Idle: `requestIdleCallback` with a timeout, or at once in a hidden tab
 * (including a tab hidden while waiting), where no frame is at stake.
 *
 * Viewer code schedules through afterLoad.ts (`runAfterModelSettled`,
 * `afterModelSettled`), which loads this module lazily and owns the settled rule.
 */

import type { useViewerStore } from '../../store/index.js';
import type { AfterLoadJob, AfterLoadOptions } from './afterLoad.js';

const ORDER: Record<AfterLoadJob, number> = { 'snapshot-write': 0, 'overlay-parse': 1, 'source-compaction': 2, 'search-index': 3 };
const IDLE_TIMEOUT_MS = 1000;
let holdLimitMs = 15_000;

type ViewerState = ReturnType<typeof useViewerStore.getState>;

/**
 * What the queue reads, handed in by afterLoad.ts so this module imports nothing
 * (its lazy chunk then has no dependency list to preload).
 */
export interface AfterLoadEnv {
  getState(): ViewerState;
  subscribe(listener: () => void): () => void;
  subscribeShards(listener: () => void): () => void;
  settled(state: ViewerState, modelId: string | null): boolean;
}
let env!: AfterLoadEnv;

interface Job extends AfterLoadOptions {
  seq: number;
  work: ((signal: AbortSignal) => unknown) | null;
  controller: AbortController;
  /** Whether the model record was present when the job was scheduled. */
  hadRecord: boolean;
  onDrop?: () => void;
}

let seq = 0;
let jobs: Job[] = [];
/** Jobs whose work has started and not yet finished: removal or a reload aborts their signal too. */
const started = new Set<Job>();
let running = false;
let waiting = false;
let unsubscribe: (() => void) | null = null;

/** Re-check on every store change and every shard-queue change (shards are not store state). */
function listen(): () => void {
  const fromStore = env.subscribe(() => pump());
  const fromShards = env.subscribeShards(() => pump());
  return () => { fromStore(); fromShards(); };
}

function alive(job: Job, state: ViewerState): boolean {
  const model = job.modelId === null ? undefined : state.models.get(job.modelId);
  if (model) return job.store == null || model.ifcDataStore === job.store;
  // A record that left (removal, reload, session reset) ends the job.
  if (job.hadRecord) return false;
  // No record: the legacy single-model store, bound to the viewer's current store.
  return job.store == null || state.ifcDataStore === job.store;
}

function drop(job: Job): void {
  const onDrop = job.onDrop;
  job.onDrop = undefined;
  job.work = null;
  job.controller.abort();
  onDrop?.();
}

function sweep(state: ViewerState): void {
  const gone = jobs.filter((job) => !alive(job, state));
  if (gone.length > 0) jobs = jobs.filter((job) => !gone.includes(job));
  const stopped = [...started].filter((job) => !alive(job, state));
  for (const job of stopped) started.delete(job);
  if (jobs.length === 0 && started.size === 0 && unsubscribe && !running) { unsubscribe(); unsubscribe = null; }
  // After the queue is updated: an `onDrop` may write the store, which re-enters `pump`.
  for (const job of gone) drop(job);
  for (const job of stopped) job.controller.abort();
}

function nextReady(state: ViewerState): Job | undefined {
  let best: Job | undefined;
  for (const job of jobs) {
    if (!env.settled(state, job.modelId)) continue;
    if (!best || ORDER[job.job] < ORDER[best.job] || (ORDER[job.job] === ORDER[best.job] && job.seq < best.seq)) best = job;
  }
  return best;
}

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** Resolve in the next idle period, or at once when the tab is (or becomes) hidden. */
export function idlePeriod(timeoutMs = IDLE_TIMEOUT_MS): Promise<void> {
  if (hidden()) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let handle: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (handle !== null) window.cancelIdleCallback?.(handle);
      if (timer !== null) clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      resolve();
    };
    const onVisibility = () => { if (hidden()) finish(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') handle = window.requestIdleCallback(finish, { timeout: timeoutMs });
    else timer = setTimeout(finish, 0);
  });
}

function pump(): void {
  const state = env.getState();
  // Sweep on every store change, also while a job runs: a removed model's queued work goes now.
  sweep(state);
  if (running || waiting || !nextReady(state)) return;
  waiting = true;
  void idlePeriod().then(async () => {
    waiting = false;
    const now = env.getState();
    sweep(now);
    const job = nextReady(now);
    if (!job) return pump();
    jobs = jobs.filter((j) => j !== job);
    const work = job.work;
    job.work = null;
    job.onDrop = undefined;
    running = true;
    started.add(job);
    let limit: ReturnType<typeof setTimeout> | undefined;
    const done = Promise.resolve().then(() => work?.(job.controller.signal))
      .then(() => {}, (error: unknown) => console.warn(`[afterLoadIdle] ${job.job} failed:`, error))
      .finally(() => {
        started.delete(job);
        if (jobs.length === 0 && started.size === 0 && unsubscribe && !running) { unsubscribe(); unsubscribe = null; }
      });
    try {
      await Promise.race([done, new Promise<void>((resolve) => { limit = setTimeout(resolve, holdLimitMs); })]);
    } finally {
      clearTimeout(limit);
      running = false;
      if (jobs.length === 0 && started.size === 0 && unsubscribe) { unsubscribe(); unsubscribe = null; }
      pump();
    }
  });
}

/**
 * Queue `work` for after `options.modelId` has settled, in an idle period, in job
 * order (see the module comment). `hadRecord`: whether the model had a record
 * when the caller scheduled it. Returns a cancel; cancelling a job that has
 * started aborts its signal. Viewer code calls `runAfterModelSettled` (afterLoad.ts).
 */
export function scheduleAfterLoad(with_: AfterLoadEnv, options: AfterLoadOptions, hadRecord: boolean, work: (signal: AbortSignal) => unknown, onDrop?: () => void): () => void {
  env = with_;
  const job: Job = { ...options, seq: seq++, work, controller: new AbortController(), onDrop, hadRecord };
  jobs.push(job);
  unsubscribe ??= listen();
  pump();
  return () => {
    jobs = jobs.filter((j) => j !== job);
    drop(job);
  };
}

/** Test-only: drop every job and listener; `holdLimit` shortens how long a job may hold the queue. */
export function __resetAfterLoadIdleForTests(holdLimit = 15_000): void {
  holdLimitMs = holdLimit;
  for (const job of jobs) drop(job);
  for (const job of started) job.controller.abort();
  started.clear();
  jobs = [];
  running = false;
  waiting = false;
  unsubscribe?.();
  unsubscribe = null;
}
