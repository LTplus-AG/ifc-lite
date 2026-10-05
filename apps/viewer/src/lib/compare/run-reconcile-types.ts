/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shapes shared by run capture, reconciliation and the panel (#6921). */

import type { ClashResult } from '@ifc-lite/clash';
import type { ValidationReport } from '@ifc-lite/ids';
import type { AnalysisStamp } from '@/hooks/useAnalysisStaleness';

interface CapturedRunBase {
  id: string;
  capturedAt: string;
  /** Federation model ids the run actually examined; null when unknown. */
  modelIds: string[] | null;
  /** Analysis stamp at run time; a later edit makes the run stale. Null means
   *  freshness is unknown, and such a run is never reconciled. */
  stamp: AnalysisStamp | null;
}

/** A completed native run held for reconciliation. Never re-run, never edited. */
export type CapturedRun =
  | CapturedRunBase & { kind: 'clash'; result: ClashResult }
  | CapturedRunBase & { kind: 'validation'; report: ValidationReport };

export type RunKind = CapturedRun['kind'];

/** Why two runs cannot be reconciled. Codes are stable; `detail` is native text. */
export type IncompatibilityCode =
  | 'kindDiffers'
  | 'noComparison'
  | 'runModelsUnknown'
  | 'baseModelNotInRun'
  | 'headModelNotInRun'
  | 'rulesDiffer'
  | 'settingsDiffer'
  | 'scopeDiffers'
  | 'sourceDiffers'
  | 'sourceUnknown'
  | 'specificationsDiffer'
  | 'runStale'
  | 'runFreshnessUnknown';

export interface Incompatibility {
  code: IncompatibilityCode;
  detail?: string;
  /** Which picked run(s) a run-level code is about (`runStale`, `runFreshnessUnknown`). */
  sides?: Array<'base' | 'head'>;
}

export type ReconcileState = 'new' | 'resolved' | 'persisting' | 'changed' | 'notEvaluated';

/** Why an absent base finding is not called resolved, or a head finding absent from base not called new. */
export type NotEvaluatedReason =
  | 'headRunTruncated'
  | 'ruleNotRun'
  | 'ruleMatchedNothing'
  | 'elementNotReexamined'
  | 'coverageNotAttributable'
  | 'specificationError'
  | 'entityNotEvaluated'
  | 'baseNotEvaluated';

export interface ReconciledFinding {
  state: ReconcileState;
  /** Durable cross-revision identity: clash review key, or `<specId> <GlobalId>`. */
  identity: string;
  /** Native per-run identity on each side (clash occurrence id / entity express id). */
  baseOccurrence?: string;
  headOccurrence?: string;
  label: string;
  reason?: NotEvaluatedReason;
  /** Field names whose native values differ for `changed`. */
  changes?: string[];
}

export type ReconcileCounts = Record<ReconcileState, number>;

export type ReconcileOutcome =
  | { ok: true; kind: RunKind; baseRunId: string; headRunId: string; counts: ReconcileCounts;
    findings: ReconciledFinding[]; partial: boolean;
    /** Findings left out by construction: cross-revision clashes, entities without GlobalId. */
    excluded: number }
  | { ok: false; kind: RunKind | null; baseRunId: string; headRunId: string; incompatibilities: Incompatibility[] };

/** A reconciliation as kept for the panel and the assistant: the outcome, the
 *  comparison it was computed against, and the stamps of the runs it read, so a
 *  later edit is detected after the fact. */
export interface SavedReconciliation {
  outcome: ReconcileOutcome;
  comparison: object;
  stamps: Array<AnalysisStamp | null>;
}

export interface ReconcileContext {
  baseModelId: string;
  headModelId: string;
  /** IFC class of an element in the head model, by GlobalId; undefined when absent. */
  headTypeOf: (globalId: string) => string | undefined;
  /** Whether a captured run's stamp is behind the current model state. */
  isStale: (run: CapturedRun) => boolean;
}

export function emptyCounts(): ReconcileCounts {
  return { new: 0, resolved: 0, persisting: 0, changed: 0, notEvaluated: 0 };
}
