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

/**
 * Publish a canceller for the load that `supersede` belongs to. Returns the
 * release to call when that load ends by any path; it clears the slot only
 * while the slot still holds this load's canceller.
 */
export function installModelLoadCanceller(
  kind: 'primary' | 'federated',
  supersede: () => void,
  ownedStream: () => (() => void) | null = () => null,
): () => void {
  const store = getViewerStoreApi();
  const release = () => {
    if (store.getState().activeLoadCanceller === cancel) store.getState().setActiveLoadCanceller(null);
  };
  const cancel = () => {
    // A retained reference to a load that has since ended or been replaced
    // must not supersede, or reset the viewer under, the load that owns the slot.
    if (store.getState().activeLoadCanceller !== cancel) return;
    supersede();
    release();
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
  store.getState().setActiveLoadCanceller(cancel);
  return release;
}
