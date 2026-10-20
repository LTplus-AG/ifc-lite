/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SectionExportOptions } from './section-export.js';
export type { SectionExportOptions, SectionExportPlane } from './section-export.js';

/** Load the export-only planner and writer when a section crop is requested (#7711). */
export async function exportSectionedStep(content: Uint8Array, options: SectionExportOptions) {
  const section = await import('./section-export.js');
  return section.exportSectionedStep(content, options);
}
