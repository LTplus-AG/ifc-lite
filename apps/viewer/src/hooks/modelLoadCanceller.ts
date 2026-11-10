/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * User cancel for a model load (#5849).
 *
 * The loader marks the in-flight work stale and aborts its geometry stream.
 * A primary load returns to an empty viewer; a federated add leaves the
 * already-loaded models in place. Neither path reports a user cancel as an
 * error. A load that installs `interrupt` (a retained-kernel run, #7955 M2)
 * is ended instead: it finishes with what it already published.
 *
 * The canceller is published through the store's `activeLoadCanceller`,
 * which the status-bar Cancel and the in-viewport loading card both read
 * (`selectLoadCanceller`). The slot has to live in the store: every component
 * calling `useIfc()` owns its own loader instance and session counter, and
 * only the instance that started the load can supersede it. It is not
 * `activeStreamCanceller`: GPU device-loss recovery cancels that slot, and a
 * model load must survive a device loss.
 */

import { getViewerStoreApi } from '@/store';
import { selectActiveLoadProgress, selectLoadCanceller } from '@/store/slices/loadingSlice';
import { beginActivity, discardActivity, finishActivity, updateActivity } from '@/lib/activity/activity-journal';
import type { TranslationKey } from '@/i18n';

type LoadOutcome = { outcome: 'completed' | 'failed' | 'cancelled'; detail?: string; detailKey?: TranslationKey };

interface LoadActivity {
  subject: string;
  result: (cancelRequested: boolean) => LoadOutcome;
  /** Set once a retry owns this file's outcome; the attempt's own row is then dropped. */
  handedOff?: boolean;
  /** While set, Cancel calls this instead of discarding the load. */
  interrupt?: () => void;
}

/** Per-load publication and error evidence; shared UI flags cannot settle a file. */
export function createModelLoadActivity(subject: string) {
  return {
    subject, published: false, cancelled: false, handedOff: false, error: undefined as string | undefined,
    interrupt: undefined as (() => void) | undefined,
    fail(message: string): string {
      this.error = message;
      return message;
    },
    /** A resource retry takes over: its own job reports how the file ends (J1). */
    handOff(): void {
      this.handedOff = true;
    },
    /**
     * Only a cancel reads `cancelled` (J1): an explicit one (an aborted
     * ingest), or a Cancel that interrupted a retained run before it published
     * anything. A load that ends with no model and no cancel failed.
     */
    result(cancelRequested = false): LoadOutcome {
      if (this.cancelled) return { outcome: 'cancelled' };
      // Recorded, not truthy: a bare `new Error()` fails with an empty message, and the tray then shows Failed alone.
      if (this.error !== undefined) return { outcome: 'failed', ...(this.error ? { detail: this.error } : {}) };
      if (this.published) return { outcome: 'completed' };
      if (cancelRequested) return { outcome: 'cancelled' };
      return { outcome: 'failed', detailKey: 'activityTray.load.noModel' };
    },
  };
}

/**
 * Hand a failed attempt's file to its resource retry (J1). The retry's own job
 * reports how the file ends; the attempt's row is dropped when the retry
 * supersedes it, never read as a cancel. With no retry to run there is no
 * hand-off, so the attempt still settles its own row.
 */
export async function handOffToRetry(
  activity: { handOff(): void },
  retry: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!retry) return;
  activity.handOff();
  await retry();
}

type LoadProgress = ReturnType<typeof selectActiveLoadProgress>;

/** The terminal progress of a load that ran to its end (#1570: picking reads `percent < 100`). */
export const LOAD_COMPLETE: NonNullable<LoadProgress> = { phase: 'Complete', percent: 100 };

/**
 * End the shared load UI for a path that holds no canceller of its own: a
 * raster drape or a retained refusal (both return before a canceller is
 * installed, after `addModel` raised the spinner for them), and the last
 * federated Cancel. While a model load or point-cloud stream still holds the
 * Cancel (`selectLoadCanceller`), the spinner and progress are that load's to
 * end. `error` and its Retry are never cleared here: none of these paths
 * reported one, so whatever is shown belongs to another load.
 */
export function settleUnownedLoadUi(progress: LoadProgress = null): void {
  const state = getViewerStoreApi().getState();
  if (selectLoadCanceller(state) !== null) return;
  state.setLoading(false);
  state.setGeometryStreamingActive(false);
  state.setProgress(progress);
  state.setGeometryProgress(null);
  state.setMetadataProgress(null);
  state.setLoadingFileName(null);
}

/**
 * End one load's share of the shared load UI (L2). Every load end, completed
 * or failed, releases its Cancel first; the spinner, streaming flag and
 * progress then end only once no other load or stream still holds the Cancel,
 * so a load that finishes first never ends the UI of one still running.
 */
export function settleOwnedLoadUi(release: () => void, progress: LoadProgress = null): void {
  release();
  settleUnownedLoadUi(progress);
}

// Hook instances are independent; a replacement primary invalidates every
// unfinished load, while concurrent federated additions remain independent.
const pendingLoads = new Map<() => void, () => void>();

/** Work waiting to start a load, keyed to the newer load starts that supersede it. */
const supersessionWatches = new Map<AbortController, 'primary' | 'any'>();

/**
 * A signal that aborts when a newer load starts (L6, L9): with `'primary'`
 * only a load that replaces the scene, with `'any'` every load the user
 * starts. Work that waits before its own load begins (a queued federated add,
 * a URL autoload's fetch, a reload resume, a cache revalidation) checks it
 * before loading. `stop` ends the watch; call it before starting that load,
 * or once the work ends.
 */
export function watchLoadSupersession(scope: 'primary' | 'any'): { signal: AbortSignal; stop(): void } {
  const controller = new AbortController();
  supersessionWatches.set(controller, scope);
  return { signal: controller.signal, stop: () => { supersessionWatches.delete(controller); } };
}

/**
 * Publish a canceller for the load that `supersede` belongs to. Returns the
 * release to call when that load ends by any path; it clears the slot only
 * while the slot still holds this load's canceller.
 */
export function installModelLoadCanceller(
  kind: 'primary' | 'federated',
  supersede: () => void,
  ownedStream: () => (() => void) | null = () => null,
  activity?: LoadActivity,
): () => void {
  const store = getViewerStoreApi();
  for (const [watch, scope] of [...supersessionWatches]) {
    if (scope === 'primary' && kind !== 'primary') continue;
    supersessionWatches.delete(watch);
    watch.abort();
  }
  if (kind === 'primary') {
    for (const abandon of [...pendingLoads.keys()]) abandon();
  }
  let released = false;
  let abandoned = false;
  let cancelRequested = false;
  let stopProgress = () => {};
  let jobId: string | undefined;
  const release = () => {
    if (released) return;
    released = true;
    stopProgress();
    if (jobId && activity?.handedOff) discardActivity(jobId);
    else if (jobId && activity) {
      // Superseded (Cancel, or a new primary load): the load did not run to an end of its own.
      const { outcome, detail, detailKey } = abandoned ? { outcome: 'cancelled' as const } : activity.result(cancelRequested);
      finishActivity(jobId, outcome, { ...(detail ? { detail } : {}), ...(detailKey ? { detailKey } : {}) });
    }
    pendingLoads.delete(abandon);
    if (store.getState().activeLoadCanceller === cancel) {
      store.getState().setActiveLoadCanceller([...pendingLoads.values()].at(-1) ?? null);
    }
  };
  const abandon = () => {
    if (released) return;
    abandoned = true;
    supersede();
    const stream = ownedStream();
    if (stream) {
      stream();
      if (store.getState().activeStreamCanceller === stream) store.getState().setActiveStreamCanceller(null);
    }
    release();
  };
  const cancel = () => {
    // A retained reference to a load that has since ended or been replaced
    // must not supersede, or reset the viewer under, the load that owns the slot.
    if (released) return;
    cancelRequested = true;
    // A retained run keeps its published products; its stream then completes the load.
    if (activity?.interrupt) { activity.interrupt(); return; }
    // Keep the native cancellation counter for other load observers.
    store.getState().noteLoadCancelled();
    // A primary's scene is the one every pending federated add is joining
    // (installing the primary abandoned all earlier loads), so its Cancel
    // ends them too; a federated Cancel ends only its own load (L5).
    if (kind === 'primary') for (const pending of [...pendingLoads.keys()]) pending();
    else abandon();
    const state = store.getState();
    // Stop this load's point-cloud stream too. A federated add may overlap
    // another load, so only cancel its own stream handle in that case.
    const cancelStream = kind === 'primary' ? state.activeStreamCanceller : ownedStream();
    if (cancelStream && state.activeStreamCanceller === cancelStream) {
      cancelStream();
      state.setActiveStreamCanceller(null);
    }
    if (kind === 'primary') {
      // The same reset a primary load starts with (useIfcLoader.loadFile).
      state.resetViewerState();
      state.clearAllModels();
      state.clearLayerStack();
    } else {
      // A federated add has not registered its model yet. Clear only load UI
      // (once no other load holds it); the prior scene, selection and model
      // map belong to the user.
      settleUnownedLoadUi();
    }
  };
  if (activity) {
    jobId = beginActivity({ kind: 'load', title: 'activityTray.job.load', panel: 'loadReport', subject: activity.subject, cancel });
    stopProgress = store.subscribe((state) => {
      // Shared status-bar progress belongs only to its current owner. Another
      // federated run must never overwrite this file's phase or finish it.
      if (state.activeLoadCanceller === cancel && jobId) {
        updateActivity(jobId, { phase: selectActiveLoadProgress(state)?.phase });
      }
    });
  }
  pendingLoads.set(abandon, cancel);
  store.getState().setActiveLoadCanceller(cancel);
  return release;
}
