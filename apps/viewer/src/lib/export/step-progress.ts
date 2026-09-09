/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StepExportProgress } from '@ifc-lite/export';

/** Shared shape consumed by the export dialog's progress display. */
export function stepExportProgress(progress: StepExportProgress) {
  return {
    phase: progress.phase === 'preparing' ? 'Preparing export...'
      : progress.phase === 'entities' ? 'Processing entities...' : 'Assembling file...',
    percent: progress.percent,
    entitiesProcessed: progress.entitiesProcessed,
    entitiesTotal: progress.entitiesTotal,
  };
}
