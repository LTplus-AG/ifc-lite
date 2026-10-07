/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * User cancel for a model load (#5849).
 *
 * The loader marks the in-flight work stale and aborts its geometry stream.
 * A primary load returns to an empty viewer; a federated add leaves the
 * already-loaded models in place. Neither path reports a user cancel as an
 * error.
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
import { selectActiveLoadProgress } from '@/store/slices/loadingSlice';
import { beginActivity, finishActivity, updateActivity } from '@/lib/activity/activity-journal';

interface LoadActivity {
  subject: string;
  result: () => { outcome: 'completed' | 'failed' | 'cancelled'; detail?: string };
}

// Hook instances are independent; a replacement primary invalidates every
// unfinished load, while concurrent federated additions remain independent.
const pendingLoads = new Set<() => void>();

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
  if (kind === 'primary') {
    for (const abandon of [...pendingLoads]) abandon();
  }
  let released = false;
  let abandoned = false;
  let stopProgress = () => {};
  let jobId: string | undefined;
  const release = () => {
    if (released) return;
    released = true;
    stopProgress();
    if (jobId) {
      const result = abandoned ? { outcome: 'cancelled' as const } : activity?.result() ?? { outcome: 'cancelled' as const };
      finishActivity(jobId, result.outcome, result.detail ? { detail: result.detail } : {});
    }
    pendingLoads.delete(abandon);
    if (store.getState().activeLoadCanceller === cancel) store.getState().setActiveLoadCanceller(null);
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
    const ownsUi = store.getState().activeLoadCanceller === cancel;
    // Before the load UI clears: the activity tray reads this when `loading` drops.
    store.getState().noteLoadCancelled();
    abandon();
    const state = store.getState();
    // Stop this load's point-cloud stream too. A federated add may overlap
    // another load, so only cancel its own stream handle in that case.
    const cancelStream = kind === 'primary' ? state.activeStreamCanceller : ownedStream();
    if (cancelStream && state.activeStreamCanceller === cancelStream) {
      cancelStream();
      state.setActiveStreamCanceller(null);
    }
    if (!ownsUi || pendingLoads.size > 0) return;
    if (kind === 'primary') {
      // The same reset a primary load starts with (useIfcLoader.loadFile).
      state.resetViewerState();
      state.clearAllModels();
      state.clearLayerStack();
    } else {
      // A federated add has not registered its model yet. Clear only load UI;
      // the prior scene, selection and model map belong to the user.
      state.setLoading(false);
      state.setGeometryStreamingActive(false);
      state.setProgress(null);
      state.setGeometryProgress(null);
      state.setMetadataProgress(null);
      state.setLoadingFileName(null);
      state.setError(null);
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
  pendingLoads.add(abandon);
  store.getState().setActiveLoadCanceller(cancel);
  return release;
}
