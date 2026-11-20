/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { snapshotSettings } from '@/store/slices/clashSlice';
import { deriveGroups } from '@/store/slices/clash-result-projection';
import { buildInitialPresets, loadExclusions, loadReviews, loadSettings } from '../clash/persistence.js';
import { EXCLUSIONS_KEY, PRESETS_KEY, REVIEWS_KEY, SCHEMA_VERSION, SETTINGS_KEY, encodeStoredReviews } from '../clash/persistence-codecs.js';
import { DEFINITION_LIBRARY_KEY, encodeDefinitionLibrary } from '../validation/definition-library.js';
import { encodeManualLibrary, loadManualLibrary, MANUAL_LIBRARY_KEY } from '../validation/manual/persistence.js';
import { manualLibraryProjection } from '../validation/manual/library.js';
import { optionalLocalStorage } from './unreadable-entry.js';
import { localWorkOriginal } from './local-work-backup.js';
import type { ContentDraftEvidence } from './content-backup-drafts.js';
import type { LocalWorkKey } from './local-work-codecs.js';

function storageSlotAbsent(key: LocalWorkKey): boolean {
  try { return optionalLocalStorage()?.getItem(key) === null; }
  catch (error) {
    console.warn(`[Library] Could not check the saved editor record for ${key}`, error);
    return false;
  }
}

/** An import must not replace unsaved editor work with an older stored snapshot. */
export function canRestoreLocalWork(key: LocalWorkKey): boolean {
  const state = useViewerStore.getState();
  // An empty editor can be a refused deletion. An absent physical record,
  // however, permits recovery after an empty initialization hit quota.
  if (key === MANUAL_LIBRARY_KEY && state.manualSaveError) {
    return state.manualLibrary.checklists.length === 0
      && Object.keys(state.manualLibrary.pendingLegacyAnswers ?? {}).length === 0
      && storageSlotAbsent(key);
  }
  if (key === DEFINITION_LIBRARY_KEY && state.validationDefinitionsError) {
    return state.validationDefinitions.entries.length === 0 && storageSlotAbsent(key);
  }
  if (key === REVIEWS_KEY) return !state.clashReviewsSaveRefused;
  if (key === SETTINGS_KEY) return !state.clashSettingsSaveRefused;
  // Presets and exclusions only publish edits after successful native saves.
  return true;
}

const EDITOR_KEYS = [REVIEWS_KEY, SETTINGS_KEY, DEFINITION_LIBRARY_KEY, MANUAL_LIBRARY_KEY] as const;

export function hasUnsavedLocalWork(): boolean {
  return EDITOR_KEYS.some(key => !canRestoreLocalWork(key));
}

/** Preserve refused editor state beside the durable library and any peer edits. */
export function readUnsavedLocalWorkDrafts(): ContentDraftEvidence[] {
  const state = useViewerStore.getState();
  const { groupBy: _displayOnly, ...settings } = snapshotSettings(state);
  const encode = {
    [REVIEWS_KEY]: () => encodeStoredReviews(state.clashReviews),
    [SETTINGS_KEY]: () => JSON.stringify({ schemaVersion: SCHEMA_VERSION, settings }),
    [DEFINITION_LIBRARY_KEY]: () => encodeDefinitionLibrary(state.validationDefinitions),
    [MANUAL_LIBRARY_KEY]: () => encodeManualLibrary(state.manualLibrary, false),
  };
  const drafts: ContentDraftEvidence[] = [];
  for (const key of EDITOR_KEYS) {
    if (canRestoreLocalWork(key)) continue;
    const raw = encode[key]();
    if (raw !== null) drafts.push(localWorkOriginal(key, raw));
  }
  return drafts;
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
