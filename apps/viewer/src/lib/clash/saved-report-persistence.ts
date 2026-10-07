/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ContentDefinition } from '../storage/content-migration.js';
import { isSavedClashReport, type SavedClashReport } from './saved-report-schema';

/** Saved clash reports (#6947) as a native content kind. No older viewer wrote
 * this key, so the migration finds nothing and only records its marker. */
export const clashReportsContent: ContentDefinition<SavedClashReport> = {
  kind: 'clashReports', legacyKey: 'ifc-lite-clash-reports',
  decode: value => isSavedClashReport(value) ? value : null,
};
