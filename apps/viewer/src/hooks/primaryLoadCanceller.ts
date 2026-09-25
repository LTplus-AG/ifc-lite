/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * User cancel for a primary model load (#5849).
 *
 * A load is cancelled the way a newer load already supersedes it: the
 * loader's session counter moves on, so every step still in flight (parser,
 * geometry stream, finalize) sees a stale session at its next await and
 * stops without writing to the store. On top of that, cancel returns the
 * viewer to its empty, idle state: no half-loaded model, no spinner and no
 * error, because the user chose this.
 *
 * The canceller is published through the store's `activeStreamCanceller`,
 * the slot point-cloud streams already use, so the status-bar Cancel and the
 * in-viewport loading card drive the same function. The slot has to live in
 * the store: every component calling `useIfc()` owns its own loader instance
 * and session counter, and only the instance that started the load can
 * supersede it.
 */

import { getViewerStoreApi } from '@/store';

/**
 * Publish a canceller for the load that `supersede` belongs to. Returns the
 * release to call when that load ends by any path; it clears the slot only
 * while the slot still holds this load's canceller.
 */
export function installPrimaryLoadCanceller(supersede: () => void): () => void {
  const store = getViewerStoreApi();
  const release = () => {
    if (store.getState().activeStreamCanceller === cancel) store.getState().setActiveStreamCanceller(null);
  };
  const cancel = () => {
    supersede();
    release();
    const state = store.getState();
    // The same reset a primary load starts with (useIfcLoader.loadFile).
    state.resetViewerState();
    state.clearAllModels();
    state.clearLayerStack();
  };
  store.getState().setActiveStreamCanceller(cancel);
  return release;
}
