/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface StepExportSummaryInput {
  /** Entity lines in the written file. */
  entityCount: number;
  /** What the dialog announced before the export: `getModifiedEntityCount` and its schedule and georef additions. */
  pendingChanges: number;
  applyMutations: boolean;
  visibleOnly: boolean;
}

/**
 * The toast after a STEP export. Its "modified" is the number the badge and the
 * dialog just showed, because the exporter's own `modifiedEntityCount` answers a
 * narrower question: source lines rewritten in place. An authored element is a
 * new line, so a session that created 399 entities read "399 entities have been
 * modified" and then "Exported 431 entities (0 modified)" (#9026). Neither
 * exporter count stands in for it: `newEntityCount` also counts generated
 * property-set lines, one edit to a wall can write several of them.
 *
 * A visible-only export writes an unknown part of the pending changes, so it
 * names no count rather than claim them all.
 */
export function stepExportSummary({ entityCount, pendingChanges, applyMutations, visibleOnly }: StepExportSummaryInput): string {
  const exported = `Exported ${entityCount} entities`;
  if (visibleOnly) return exported;
  return `${exported} (${applyMutations ? pendingChanges : 0} modified)`;
}
