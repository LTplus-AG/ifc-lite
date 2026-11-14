/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { roomStepExportSource, type RoomStepExportSource } from '@/lib/collab/room-step-export';
import { roomSymbolicSource } from '@/lib/collab/room-symbolic-source';

/**
 * Why a STEP writer has no records to read for a store: `'roomMoved'` for a
 * shared room whose live entities (or the edits being applied) are no longer
 * covered by its portable source, `'noRecords'` for any other tabular store.
 */
export type StepRecordsRefusal = 'roomMoved' | 'noRecords';

/** The shared check used by the dialog and STEP writer for absent STEP records. */
export function stepRecordsUnavailableReason(store: IfcDataStore): 'noRecords' | null {
  return store.sourceKind === 'tabular' && !roomSymbolicSource(store) ? 'noRecords' : null;
}

/** A refusal, not a crash. User-facing wording lives in the `exportDialog.stepRecords.*` catalogue keys. */
export class StepRecordsUnavailableError extends Error {
  constructor(readonly reason: StepRecordsRefusal, readonly modelName?: string) {
    super(reason === 'roomMoved'
      ? 'The shared model no longer matches the IFC file it was shared from'
      : 'The model has no IFC STEP records to export from');
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

/**
 * Where a STEP writer reads this store's records. Returns the room's portable
 * source when it covers the live room, or `null` when the store's own `source`
 * holds STEP records. Throws {@link StepRecordsUnavailableError} otherwise: a
 * tabular store's `source` is its reader's own format, so writing it as STEP
 * yields an empty or garbage file (#10045).
 */
export function stepExportSource(
  store: IfcDataStore,
  view: MutablePropertyView | undefined,
  modelId: string,
  modelName?: string,
): RoomStepExportSource | null {
  const portable = roomStepExportSource(store, view, modelId);
  if (portable) return portable;
  if (roomSymbolicSource(store)) throw new StepRecordsUnavailableError('roomMoved', modelName);
  const reason = stepRecordsUnavailableReason(store);
  if (reason) throw new StepRecordsUnavailableError(reason, modelName);
  return null;
}
