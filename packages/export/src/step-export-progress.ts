/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StepExportOptions, StepExportProgress } from './step-export-types.js';

/** Preserve the async export's progress callbacks and cancellation boundaries. */
export async function reportStepExportProgress(
  report: StepExportOptions['onProgress'], phase: StepExportProgress['phase'], percent: number, total: number,
): Promise<void> {
  report?.({ phase, percent, entitiesProcessed: phase === 'assembling' ? total : 0, entitiesTotal: total });
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}
