/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What produced the stored `listResult` (#6833): the definition that was
 * executed and the analysis stamp taken when its run started. Kept beside the
 * result object (like `stampAnalysisReport`) rather than inferred from
 * `activeListId`, which already names the NEXT list while a run is in flight
 * or after one failed, so it can disagree with the rows on screen.
 */

import type { ListDefinition, ListResult } from '@ifc-lite/lists';
import { analysisStampOf, stampAnalysisReport, type AnalysisStamp } from '@/hooks/useAnalysisStaleness';

const runDefinitions = new WeakMap<ListResult, ListDefinition>();

/** Record a freshly executed result: the run-start stamp and the executed definition. */
export function recordListRun(result: ListResult, definition: ListDefinition, stamp: AnalysisStamp): ListResult {
  runDefinitions.set(result, definition);
  return stampAnalysisReport(result, stamp);
}

/**
 * A result re-derived from an existing one (regrouped over the same rows)
 * keeps the original run's stamp: its rows are no fresher than that run.
 */
export function carryListRun(from: ListResult, to: ListResult, definition: ListDefinition): ListResult {
  runDefinitions.set(to, definition);
  const stamp = analysisStampOf(from);
  return stamp ? stampAnalysisReport(to, stamp) : to;
}

/** The executed definition, or null for a result stored without provenance. */
export function listRunDefinition(result: ListResult): ListDefinition | null {
  return runDefinitions.get(result) ?? null;
}
