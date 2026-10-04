/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ContentDefinition } from '../../storage/content-migration.js';
import { readContentEntries } from '../../storage/content-reader.js';
import { validateSavedReport, type SavedValidationReport } from './history.js';

export const VALIDATION_REPORTS_STORAGE_KEY = 'ifc-lite-validation-reports-v1';
export const validationContent: ContentDefinition<SavedValidationReport> = {
  kind: 'validation', legacyKey: VALIDATION_REPORTS_STORAGE_KEY,
  decode: value => validateSavedReport(value) ? value : null,
};
export function loadValidationReports(): Promise<SavedValidationReport[]> {
  return readContentEntries(validationContent);
}
