/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { deriveGroups } from '@/store/slices/clash-result-projection';
import { buildInitialPresets, loadExclusions, loadReviews, loadSettings } from '../clash/persistence.js';
import { EXCLUSIONS_KEY, PRESETS_KEY, REVIEWS_KEY, SETTINGS_KEY } from '../clash/persistence-codecs.js';
import { DEFINITION_LIBRARY_KEY } from '../validation/definition-library.js';
import { loadManualLibrary, MANUAL_LIBRARY_KEY } from '../validation/manual/persistence.js';
import { manualLibraryProjection } from '../validation/manual/library.js';
import type { LocalWorkKey } from './local-work-codecs.js';

/** An import must not replace unsaved editor work with an older stored snapshot. */
export function canRestoreLocalWork(key: LocalWorkKey): boolean {
  const state = useViewerStore.getState();
  if (key === MANUAL_LIBRARY_KEY) return !state.manualSaveError || !state.manualLibrary.checklists.length;
  if (key === DEFINITION_LIBRARY_KEY) return !state.validationDefinitionsError || !state.validationDefinitions.entries.length;
  return true;
}

export function refreshRestoredLocalWork(restored: LocalWorkKey[]): void {
  const state = useViewerStore.getState();
  if (restored.includes(PRESETS_KEY)) useViewerStore.setState({ clashPresets: buildInitialPresets() });
  if (restored.includes(REVIEWS_KEY)) useViewerStore.setState({ clashReviews: loadReviews() });
  const settings = restored.includes(SETTINGS_KEY) ? loadSettings() : null;
  const exclusions = restored.includes(EXCLUSIONS_KEY) ? loadExclusions() : null;
  if (settings || exclusions) {
    const epsilon = settings?.clusterEpsilon ?? state.clashClusterEpsilon;
    useViewerStore.setState({
      ...(settings ? {
        clashMode: settings.mode, clashTolerance: settings.tolerance, clashClearance: settings.clearance,
        clashDuplicateTolerance: settings.duplicateTolerance, clashClusterEpsilon: epsilon,
        clashReportTouch: settings.reportTouch,
      } : {}),
      ...(exclusions ? { clashExclusions: exclusions } : {}),
      ...deriveGroups(state, state.clashRawResult, exclusions ?? state.clashExclusions, epsilon, false),
    });
  }
  if (restored.includes(DEFINITION_LIBRARY_KEY)) state.refreshValidationDefinitions();
  if (restored.includes(MANUAL_LIBRARY_KEY)) {
    const { library, error } = loadManualLibrary();
    useViewerStore.setState({ manualLibrary: library, ...manualLibraryProjection(library), manualSaveError: error });
  }
}
