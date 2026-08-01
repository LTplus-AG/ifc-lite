/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure decision logic for `HbjsonExportDialog` (issue #1908), split out so it
 * is unit-testable without mounting a React component (this codebase has no
 * `.test.tsx` component tests — see AGENTS.md "Writing tests").
 *
 * `dataStore` is generic (structurally typed) rather than the concrete
 * `IfcDataStore` so tests can pass a minimal fixture with only the fields
 * these functions actually read, without an `as unknown as` cast (banned by
 * AGENTS.md). The production call site still passes a real `IfcDataStore`,
 * which satisfies the structural bound.
 */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { SchemaVersion } from '@/store/types';

/** The subset of `IfcDataStore` these functions read. */
export interface HbjsonSourceStore {
  source?: Uint8Array;
  schemaVersion: SchemaVersion;
}

/** Non-null pair resolved by {@link resolveHbjsonMutationSource}. */
export interface HbjsonMutationSource<T extends HbjsonSourceStore> {
  dataStore: T;
  mutationView: MutablePropertyView;
}

/**
 * Resolve whether HBJSON export should regenerate STEP bytes through
 * `StepExporter` (applying the mutation view) instead of reading the model's
 * original `sourceFile` bytes verbatim. Returns the pair to pass to
 * `StepExporter` when it should, or `null` when the raw-bytes path applies.
 *
 * Regeneration only happens when the mutation view actually carries edits
 * (`mutationView.hasPendingChanges()`) — a registered-but-untouched view is
 * the common case (opening the Properties panel, `BulkPropertyEditor`,
 * `DataConnector`, or `ExportDialog` all construct and register one on open,
 * with zero edits) and must NOT route export through a StepExporter
 * regeneration — plus a parsed data store to regenerate from, source bytes
 * for `StepExporter` to re-serialize un-mutated entities from, and a STEP
 * schema (IFC5/IFCX has no STEP representation to regenerate — that stays on
 * the raw-bytes path, unchanged from before this fix).
 *
 * `hasPendingChanges()`, not `hasChanges()`: the latter reads the
 * append-only `mutationHistory`, which `restoreNewEntity` (undo of a
 * delete-then-restore, called from `mutationSlice.ts`) repopulates
 * `newEntities` WITHOUT pushing to. `hasPendingChanges()` reads the current
 * overlay footprint instead — the same set the exporter actually reads — so
 * a restored overlay-created space is not silently missed.
 */
export function resolveHbjsonMutationSource<T extends HbjsonSourceStore>(params: {
  mutationView: MutablePropertyView | null;
  dataStore: T | null | undefined;
  schemaVersion: SchemaVersion;
}): HbjsonMutationSource<T> | null {
  const { mutationView, dataStore, schemaVersion } = params;
  if (
    !mutationView ||
    !mutationView.hasPendingChanges() ||
    !dataStore ||
    !dataStore.source ||
    dataStore.source.length === 0 ||
    schemaVersion === 'IFC5'
  ) {
    return null;
  }
  return { dataStore, mutationView };
}
