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
import { hasPendingInstancedShards } from '../../store/instancedShardQueue.js';

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

/**
 * Run `work` after `options.modelId` has settled, in an idle period, in job order
 * (afterLoadIdle.ts). Returns a cancel: before the job starts it drops the job
 * (`onDrop` runs); after, it aborts the job's signal. Whether the model had a
 * record is taken now, so a removal while the queue loads still ends the job.
 */
export function runAfterModelSettled(options: AfterLoadOptions, work: (signal: AbortSignal) => unknown, onDrop?: () => void): () => void {
  const hadRecord = options.modelId !== null && useViewerStore.getState().models.has(options.modelId);
  let cancel: (() => void) | null = null;
  let cancelled = false;
  import('./afterLoadIdle.js').then(({ scheduleAfterLoad }) => {
    if (!cancelled) cancel = scheduleAfterLoad(options, hadRecord, work, onDrop);
  }, (error: unknown) => {
    // Without the queue the work runs now, as it did before there was one.
    console.warn('[afterLoad] schedule did not load; running the job now', error);
    if (!cancelled) void Promise.resolve().then(() => work(new AbortController().signal)).catch(() => {});
  });
  return () => {
    if (cancelled) return;
    cancelled = true;
    if (cancel) cancel();
    else onDrop?.();
  };
}
