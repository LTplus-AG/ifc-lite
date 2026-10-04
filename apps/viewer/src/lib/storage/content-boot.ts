/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assistantLibrary } from '../assistant/library.js';
import { useViewerStore } from '../../store/index.js';
import { subscribeContentChanges } from './content-events.js';
import { preserveLegacyChange } from './content-backup.js';
import { documentContent } from '../document/persistence.js';
import { comparisonContent } from '../compare/savedComparisonPersistence.js';
import { validationContent } from '../validation/reports/persistence.js';

let installed = false;
export function initializeUserContent(): void {
  if (installed) return;
  installed = true;
  const state = useViewerStore.getState();
  void Promise.all([assistantLibrary.initialize(), state.initializeDocuments(), state.initializeValidationReports(), state.initializeSavedComparisons()]);
  const refresh = () => {
    const live = useViewerStore.getState();
    void Promise.all([assistantLibrary.refresh(), live.refreshDocuments(), live.refreshValidationReports(), live.refreshSavedComparisons()]);
  };
  subscribeContentChanges(kind => {
    const live = useViewerStore.getState();
    void (kind === 'assistant' ? assistantLibrary.refresh() : kind === 'document' ? live.refreshDocuments()
      : kind === 'validation' ? live.refreshValidationReports() : live.refreshSavedComparisons());
  });
  window.addEventListener('focus', refresh);
  window.addEventListener('storage', event => {
    if (!event.key || event.newValue === null) return;
    void preserveLegacyChange(event.key, event.newValue).then(() => {
      // Hydrate the controller's status too, so a later save keeps the notice.
      const live = useViewerStore.getState();
      if (event.key === documentContent.legacyKey) return live.refreshDocuments();
      if (event.key === comparisonContent.legacyKey) return live.refreshSavedComparisons();
      if (event.key === validationContent.legacyKey) return live.refreshValidationReports();
    }).catch(error => console.warn('[User content] Could not preserve an older tab change; legacy key retained', error));
  });
}
