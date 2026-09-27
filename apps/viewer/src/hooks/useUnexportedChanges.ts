/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The live set of models with pending, unexported changes: the one source the
 * Export modified IFC… badge counts and the unexported-edits guards read (#5604), so
 * a guard can never disagree with the number the user sees on the button.
 */

import { useEffect, useMemo } from 'react';
import { useViewerStore } from '@/store';
import { collectChangedModels, totalChangeCount, type ChangedModelsResult } from '@/lib/export/model-changes';

/**
 * `collectChangedModels` over the live store, recomputed when anything that
 * can change the pending-changes count changes. `mutationVersion` bumps on
 * every property / quantity / attribute / georef mutation (and after a CSV
 * import, which writes straight to a mutation view); schedule edits are
 * watched explicitly.
 */
export function useChangedModels(): ChangedModelsResult {
  const models = useViewerStore((s) => s.models);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const georefMutations = useViewerStore((s) => s.georefMutations);
  const scheduleData = useViewerStore((s) => s.scheduleData);
  const scheduleIsEdited = useViewerStore((s) => s.scheduleIsEdited);
  const scheduleSourceModelId = useViewerStore((s) => s.scheduleSourceModelId);
  const legacyIfcDataStore = useViewerStore((s) => s.ifcDataStore);

  return useMemo(
    () => collectChangedModels(useViewerStore.getState()),
    // getState() reads the live snapshot; these deps drive recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [models, mutationVersion, georefMutations, scheduleData, scheduleIsEdited, scheduleSourceModelId, legacyIfcDataStore],
  );
}

/**
 * Ask the browser to confirm leaving the page while there are unexported
 * changes (#5604). The listener is only registered while the count is above
 * zero, so an unedited session keeps a clean unload (and its bfcache entry).
 */
export function useUnexportedChangesGuard(): void {
  const hasUnexportedChanges = totalChangeCount(useChangedModels()) > 0;
  useEffect(() => {
    if (!hasUnexportedChanges) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Browsers older than the preventDefault() form only prompt when
      // returnValue is set; the text itself is ignored by every browser.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnexportedChanges]);
}
