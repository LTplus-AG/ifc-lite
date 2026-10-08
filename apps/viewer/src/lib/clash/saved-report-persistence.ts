/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ContentDefinition } from '../storage/content-migration.js';
import type { SavedClashReport } from './saved-report-schema';

let validate: ((value: unknown) => value is SavedClashReport) | null = null;

/**
 * The library actions and the report validator. Neither is needed to draw the
 * first frame, so both ship outside the boot bundle; every path that decodes a
 * report (opening the library, saving, a backup file) awaits this first.
 */
export function loadClashReportLibrary(): Promise<typeof import('./saved-report-library')> {
  return import('./saved-report-library').then((module) => { validate = module.isSavedClashReport; return module; });
}

/** Saved clash reports (#6947) as a native content kind. No older viewer wrote
 * this key, so the migration finds nothing and only records its marker. */
export const clashReportsContent: ContentDefinition<SavedClashReport> = {
  kind: 'clashReports', legacyKey: 'ifc-lite-clash-reports',
  decode: (value) => {
    // Loud on purpose: decoding with no validator would have to accept or refuse blindly.
    if (!validate) throw new Error('Clash report validator not loaded');
    return validate(value) ? value : null;
  },
};
