/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The eager half of the after-load schedule: the settled rule and a scheduling
 * call that loads the queue (`afterLoadIdle.ts`) as a lazy chunk. The queue only
 * ever runs work after a load has settled, so loading it on first use puts
 * nothing on a load's critical path and keeps it out of the eager bundle.
 */

import { useViewerStore } from '../../store/index.js';
import { hasPendingInstancedShards, subscribeInstancedShards } from '../../store/instancedShardQueue.js';
import { MAX_TAIL_WAIT_MS, viewerLoadWindow } from '../../hooks/loadWindow.js';
import type { AfterLoadEnv } from './afterLoadIdle.js';

export type AfterLoadJob = 'snapshot-write' | 'overlay-parse' | 'source-compaction' | 'search-index';

export interface AfterLoadOptions {
  job: AfterLoadJob;
  /** The model the work is for; `null` for the legacy single-model store. */
  modelId: string | null;
  /** When given, the job also ends if the model's data store is replaced. */
  store?: object | null;
}

type ViewerState = ReturnType<typeof useViewerStore.getState>;
const LOADING: ReadonlySet<string | undefined> = new Set(['pending', 'streaming-geometry', 'hydrating-metadata']);

/** Whether `modelId`'s load has settled (see afterLoadIdle.ts). `null`: the legacy single-model store. */
export function modelLoadSettled(state: ViewerState, modelId: string | null): boolean {
  if (hasPendingInstancedShards(modelId ?? undefined)) return false;
  const model = modelId === null ? undefined : state.models.get(modelId);
  if (!model) return !state.loading && !state.geometryStreamingActive;
  if (state.geometryStreamingActive && state.activeModelId === modelId) return false;
  return !LOADING.has(model.loadState);
}

/** How long a settled model's own hold may last (e.g. the window stays open across a multi-file open). */
let ownHoldCapMs = MAX_TAIL_WAIT_MS;
/** When each held model was first seen settled, per data store (a reload under the same id is a new hold). */
const heldSince = new Map<string, { store: unknown; since: number }>();
const capListeners = new Set<() => void>();

/**
 * When an after-load job may start: its model has settled AND the load window
 * (hooks/loadWindow.ts, the one definition of "the load is over") no longer holds
 * THAT model, i.e. the frame showing it settled has painted. Another model's load
 * does not hold it back: a model settled when the window opened is never held.
 * A settled model's own hold is capped at `ownHoldCapMs` (a multi-file open keeps
 * the window open until its last file; a load flag that never clears). `null`:
 * the legacy single-model store, held by the whole window.
 */
export function afterLoadReady(state: ViewerState, modelId: string | null): boolean {
  if (!modelLoadSettled(state, modelId)) { if (modelId !== null) heldSince.delete(modelId); return false; }
  const loadWindow = viewerLoadWindow();
  if (modelId === null) return !loadWindow.isOpen();
  if (!loadWindow.isHeld(modelId)) { heldSince.delete(modelId); return true; }
  const store = state.models.get(modelId)?.ifcDataStore ?? null;
  const held = heldSince.get(modelId);
  if (held && held.store === store) return Date.now() - held.since >= ownHoldCapMs;
  heldSince.set(modelId, { store, since: Date.now() });
  setTimeout(() => { for (const listener of [...capListeners]) listener(); }, ownHoldCapMs);
  return false;
}

/** Test-only: the own-hold cap; `null` restores it. */
export function __setOwnHoldCapForTests(ms: number | null): void {
  ownHoldCapMs = ms ?? MAX_TAIL_WAIT_MS;
  heldSince.clear();
}

const subscribeStoreAndWindow = (listener: () => void): (() => void) => {
  const fromStore = useViewerStore.subscribe(listener);
  const fromWindow = viewerLoadWindow().subscribe(listener);
  capListeners.add(listener);
  return () => { fromStore(); fromWindow(); capListeners.delete(listener); };
};

const ENV: AfterLoadEnv = {
  getState: () => useViewerStore.getState(),
  subscribe: subscribeStoreAndWindow,
  subscribeShards: subscribeInstancedShards,
  settled: afterLoadReady,
};

/**
 * Run `work` after `options.modelId` has settled and the load window no longer holds it, in an idle period, in job order
 * (afterLoadIdle.ts). Returns a cancel: before the job starts it drops the job
 * (`onDrop` runs); after, it aborts the job's signal. Whether the model had a
 * record is taken now, so a removal while the queue loads still ends the job.
 */
export function runAfterModelSettled(options: AfterLoadOptions, work: (signal: AbortSignal) => unknown, onDrop?: () => void): () => void {
  const hadRecord = options.modelId !== null && useViewerStore.getState().models.has(options.modelId);
  let cancel: (() => void) | null = null;
  let cancelled = false;
  const drop = () => { if (!cancelled) { cancelled = true; onDrop?.(); } };
  loadQueue().then(({ scheduleAfterLoad }) => {
    if (!cancelled) cancel = scheduleAfterLoad(ENV, options, hadRecord, work, onDrop);
  }, (error: unknown) => {
    console.warn('[afterLoad] schedule did not load; running the job here once its model settles', error);
    if (!cancelled) cancel = runWhenSettledHere(options, hadRecord, work, drop);
  });
  return () => {
    if (cancelled) return;
    // The queue's cancel and the fallback's both report a drop to `onDrop` themselves.
    if (cancel) { const end = cancel; cancel = null; end(); cancelled = true; } else drop();
  };
}

/** Whether the job's model (and store, when bound to one) is still the one it was scheduled for. */
function jobAlive(state: ViewerState, options: AfterLoadOptions, hadRecord: boolean): boolean {
  const model = options.modelId === null ? undefined : state.models.get(options.modelId);
  if (model) return options.store == null || model.ifcDataStore === options.store;
  return !hadRecord && (options.store == null || state.ifcDataStore === options.store);
}

/**
 * Without the queue: the same rules for this one job (after its model settles; dropped when the model
 * or its store goes; a started job's signal aborts then), without the idle period or the job order.
 * Returns its cancel.
 */
function runWhenSettledHere(options: AfterLoadOptions, hadRecord: boolean, work: (signal: AbortSignal) => unknown, drop: () => void): () => void {
  const controller = new AbortController();
  let started = false;
  let stop = () => {};
  const check = () => {
    const state = useViewerStore.getState();
    if (!jobAlive(state, options, hadRecord)) { stop(); if (started) controller.abort(); else drop(); return; }
    if (started || !afterLoadReady(state, options.modelId)) return;
    started = true;
    void Promise.resolve().then(() => work(controller.signal)).catch(() => {}).finally(() => stop());
  };
  const fromStore = subscribeStoreAndWindow(check);
  const fromShards = subscribeInstancedShards(check);
  stop = () => { fromStore(); fromShards(); };
  check();
  return () => { stop(); if (started) controller.abort(); else drop(); };
}

let loadQueue: () => Promise<typeof import('./afterLoadIdle.js')> = () => import('./afterLoadIdle.js');
/** Test-only: replace how the queue module loads (e.g. a chunk that fails to load); `null` restores it. */
export function __setAfterLoadQueueLoaderForTests(loader: typeof loadQueue | null): void {
  loadQueue = loader ?? (() => import('./afterLoadIdle.js'));
}

/** The same, as a promise of `work`'s result; `undefined` when the job is dropped or cancelled before it runs. */
export function afterModelSettled<T>(options: AfterLoadOptions, work: (signal: AbortSignal) => T | Promise<T>): { result: Promise<T | undefined>; cancel: () => void } {
  let settle!: (value: T | undefined) => void;
  const result = new Promise<T | undefined>((resolve) => { settle = resolve; });
  const cancel = runAfterModelSettled(options, async (signal) => {
    try { settle(await work(signal)); } catch (error) { settle(undefined); throw error; }
  }, () => settle(undefined));
  return { result, cancel };
}
