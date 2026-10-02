/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '../../store/index.js';
import { subscribeContentChanges } from './content-events.js';

let installed = false;
export function initializeUserContent(): void {
  if (installed) return;
  installed = true;
  const state = useViewerStore.getState();
  void Promise.all([state.initializeDocuments(), state.initializeValidationReports(), state.initializeSavedComparisons()]);
  const refresh = () => {
    const live = useViewerStore.getState();
    void Promise.all([live.refreshDocuments(), live.refreshValidationReports(), live.refreshSavedComparisons()]);
  };
  subscribeContentChanges(kind => {
    const live = useViewerStore.getState();
    void (kind === 'document' ? live.refreshDocuments()
      : kind === 'validation' ? live.refreshValidationReports() : live.refreshSavedComparisons());
  });
  window.addEventListener('focus', refresh);
}
