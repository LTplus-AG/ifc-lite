/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createSavedHistoryStorage } from '@/lib/storage/saved-history';
import { isSavedComparison, type SavedComparison } from './savedComparisonSchema';
export const SAVED_COMPARISONS_KEY = 'ifc-lite-saved-comparisons';

const storage = createSavedHistoryStorage(SAVED_COMPARISONS_KEY, isSavedComparison, 'saved comparisons');
export const readSavedComparisons = storage.read;
export const saveSavedComparisons = storage.save;
export function loadSavedComparisons(): SavedComparison[] { return readSavedComparisons().entries; }
