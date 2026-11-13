/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Why a STEP writer has no records to read for a store (see `stepExportSource`). */
export type StepRecordsRefusal = 'roomMoved' | 'noRecords';

/** A refusal, not a crash. User-facing wording lives in the `exportDialog.stepRecords.*` catalogue keys. */
export class StepRecordsUnavailableError extends Error {
  constructor(readonly reason: StepRecordsRefusal, readonly modelName?: string) {
    super(`No IFC STEP records to export (${reason})`);
    this.name = 'StepRecordsUnavailableError';
  }
}

/** The message an export reports for `error`: the translated refusal, or the raw failure. */
export function exportFailureMessage(
  error: unknown,
  t: (key: `exportDialog.stepRecords.${StepRecordsRefusal}`, params: { model: string }) => string,
  fallbackModelName = '',
): string {
  if (error instanceof StepRecordsUnavailableError) {
    return t(`exportDialog.stepRecords.${error.reason}`, { model: error.modelName ?? fallbackModelName });
  }
  return `Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
}
