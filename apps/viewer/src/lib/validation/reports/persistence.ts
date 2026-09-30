/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createSavedHistoryStorage } from '../../storage/saved-history.js';
import { validateSavedReport, type SavedValidationReport } from './history.js';

export const VALIDATION_REPORTS_STORAGE_KEY = 'ifc-lite-validation-reports-v1';
const historyStorage = createSavedHistoryStorage(VALIDATION_REPORTS_STORAGE_KEY, validateSavedReport, 'saved validation reports');

/** Distinguish missing history from incomplete/unavailable evidence (#6500). */
export const readValidationReports = historyStorage.read;
export function loadValidationReports(): SavedValidationReport[] {
  return readValidationReports().entries;
}

/** Keep in-memory evidence on quota failure, and never overwrite a damaged
 * original until the shared reader has safely preserved it. */
export const persistValidationReports = historyStorage.save;
