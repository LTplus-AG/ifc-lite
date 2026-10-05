/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assistantLibrary } from '../assistant/library.js';
import { clashGroupLibrary } from '../clash/group-workspace.js';
import { bcfDraftLibrary } from '../bcf-drafts/draft-library.js';
import { bcfOutboxLibrary, initializeBcfOutbox } from '../bcf-publication/outbox-store.js';
import { modelChangeLibrary } from '../actions/receipts.js';
import { useViewerStore } from '../../store/index.js';
import { subscribeContentChanges } from './content-events.js';
import { preserveLegacyChange } from './content-backup.js';
import { contentKindForLegacyKey } from './content-registry.js';
import type { ContentKind } from './content-kinds.js';

/** Adding an artifact kind must provide native initialization and refresh at compile time. */
function contentHosts() {
  const state = useViewerStore.getState();
  return {
    assistant: { initialize: assistantLibrary.initialize, refresh: assistantLibrary.refresh },
    clashGroups: { initialize: clashGroupLibrary.initialize, refresh: clashGroupLibrary.refresh },
    bcfDrafts: { initialize: bcfDraftLibrary.initialize, refresh: bcfDraftLibrary.refresh },
    bcfOutbox: { initialize: initializeBcfOutbox, refresh: bcfOutboxLibrary.refresh },
    modelChanges: { initialize: modelChangeLibrary.initialize, refresh: modelChangeLibrary.refresh },
    document: { initialize: state.initializeDocuments, refresh: state.refreshDocuments },
    validation: { initialize: state.initializeValidationReports, refresh: state.refreshValidationReports },
    comparison: { initialize: state.initializeSavedComparisons, refresh: state.refreshSavedComparisons },
  } satisfies Record<ContentKind, { initialize: () => Promise<unknown>; refresh: () => Promise<unknown> }>;
}

let installed = false;
export function initializeUserContent(): void {
  if (installed) return;
  installed = true;
  void Promise.all(Object.values(contentHosts()).map(host => host.initialize()));
  const refresh = () => {
    void Promise.all(Object.values(contentHosts()).map(host => host.refresh()));
  };
  subscribeContentChanges(kind => {
    void contentHosts()[kind].refresh();
  });
  window.addEventListener('focus', refresh);
  window.addEventListener('storage', event => {
    if (!event.key || event.newValue === null) return;
    void preserveLegacyChange(event.key, event.newValue).then(() => {
      // Hydrate the controller's status too, so a later save keeps the notice.
      const kind = event.key && contentKindForLegacyKey(event.key);
      if (kind) return contentHosts()[kind].refresh();
    }).catch(error => console.warn('[User content] Could not preserve an older tab change; legacy key retained', error));
  });
}
