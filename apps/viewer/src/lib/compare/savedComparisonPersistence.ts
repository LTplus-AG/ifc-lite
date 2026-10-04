/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ContentDefinition } from '../storage/content-migration.js';
import { readContentEntries } from '../storage/content-reader.js';
import { isSavedComparison, type SavedComparison } from './savedComparisonSchema';
export const SAVED_COMPARISONS_KEY = 'ifc-lite-saved-comparisons';
export const comparisonContent: ContentDefinition<SavedComparison> = {
  kind: 'comparison', legacyKey: SAVED_COMPARISONS_KEY,
  decode: value => isSavedComparison(value) ? value : null,
};
export function loadSavedComparisons(): Promise<SavedComparison[]> {
  return readContentEntries(comparisonContent);
}
