/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unified coordination findings (viewer AI P18, #6922).
 *
 * Every native analysis keeps its own run, status vocabulary and panel. The
 * review workspace only *normalises* what those analyses already produced into
 * one finding shape so findings that point at the same validated elements can
 * be read together. Nothing here re-runs, re-scores or rewrites a native
 * result: `nativeStatus` is copied verbatim and `evidence` points back to the
 * exact native row so the original stays one click away.
 */

/** The analyses a finding can come from. */
export type FindingSourceKind = 'clash' | 'validation' | 'comparison' | 'bcf' | 'linked';
export const FINDING_SOURCE_KINDS: readonly FindingSourceKind[] = ['clash', 'validation', 'comparison', 'bcf', 'linked'];

/**
 * One native run (or record set). `current` is the result held live in the
 * viewer now; `historical` is saved evidence (a clash baseline, a saved
 * comparison). Historical evidence never becomes current by matching.
 */
export interface FindingRun {
  /** Unique within one review snapshot. */
  id: string;
  source: FindingSourceKind;
  temporal: 'current' | 'historical';
  /** Native label (IDS title, rule set, comparison name, BCF project). */
  label: string;
  /** ISO time the native run finished or the evidence was saved; null when the source records none. */
  capturedAt: string | null;
  /**
   * The run evaluated its whole declared population: no cap, no failed check,
   * no edits since it ran. Only a complete current run can confirm that a
   * historical finding is no longer observed.
   */
  complete: boolean;
  /** Why the run is not complete; `detail` carries native wording such as a truncation reason. */
  incomplete: RunGap[];
  /** Durable names of the models the run evaluated. */
  models: string[];
}

export type RunGapCode = 'truncated' | 'stale' | 'check-error' | 'sets-truncated' | 'partial-source' | 'geometry-unavailable'
  | 'placement-only' | 'excluded-classes';
export interface RunGap { code: RunGapCode; detail?: string }

/** An element a finding refers to, as the native source names it. */
export interface FindingElement {
  /** IFC GlobalId. */
  globalId: string;
  /** Live viewer model id when the native source names one; null when it does not (BCF components, linked records). */
  modelId: string | null;
  /** Durable model name (file name) when known; historical evidence carries only this. */
  modelName: string | null;
  ifcType?: string;
  name?: string;
  /** The native source itself could not identify the element; it is never merged by GlobalId alone. */
  nativeUnresolved?: 'ambiguous' | 'unmatched';
}

/** Exactly where the original evidence lives, so a click can open it. */
export type FindingEvidence =
  | { kind: 'clash'; clashId: string; occurrenceKey: string; reviewKey: string }
  | { kind: 'clash-baseline'; reviewKey: string }
  | { kind: 'clash-group-application'; applicationId: string; groupId: string }
  | { kind: 'validation'; specificationId: string; modelId: string; expressId: number }
  | { kind: 'run-reconciliation'; baseRunId: string; headRunId: string; identity: string }
  | { kind: 'comparison'; key: string }
  | { kind: 'saved-comparison'; comparisonId: string; key: string }
  | { kind: 'bcf'; topicGuid: string }
  | { kind: 'linked'; resourceId: string };

/**
 * Lifecycle of one finding relative to the other runs of its own source.
 * `observed`: current, no compatible earlier run to compare with.
 * `new` / `persistent`: current, absent from / present in a compatible earlier run.
 * `no-longer-observed`: historical only, and a complete compatible current run
 *   re-examined it (a resolution *candidate*, never a resolution).
 * `not-evaluated`: historical only, and no complete compatible current run
 *   could have seen it.
 * `record`: a coordination record (BCF topic or grouping receipt) whose native status is authoritative.
 */
export type FindingLifecycle = 'observed' | 'new' | 'persistent' | 'no-longer-observed' | 'not-evaluated' | 'record';

export interface ReviewFinding {
  /** Unique per run: `${run.id}#${native id}`. */
  id: string;
  /** Run-independent identity used to pair the same finding across runs of one source. */
  lineage: string;
  source: FindingSourceKind;
  run: FindingRun;
  elements: FindingElement[];
  /** Native status, copied verbatim (clash class, IDS outcome, change state, topic status, severity). */
  nativeStatus: string;
  /** Short native description: rule, specification, change kinds, topic title. */
  title: string;
  /** Extra native lines for the detail view (failed requirements, changed components). */
  detail: string[];
  lifecycle: FindingLifecycle;
  /** Discipline candidates from the native taxonomy; overlapping and empty lists stay as given. */
  disciplines: string[];
  /** Storey names when the native source or the live model can supply them. */
  storeys: string[];
  evidence: FindingEvidence;
}

/** What a source contributes to one review snapshot. */
export interface FindingSourceResult {
  runs: FindingRun[];
  findings: ReviewFinding[];
}

/** A model as the review layer sees it: identity plus a GlobalId lookup. */
export interface ReviewModel {
  id: string;
  name: string;
  /** Returns a positive express id, or a value <= 0 when the GlobalId is not in the model. */
  expressIdOf(globalId: string): number;
  globalIdOf(expressId: number): string;
  storeyOf?(expressId: number): string | null;
}

/**
 * The seam other packages plug into. A source reads its own native state
 * (store slices, libraries) and returns normalised findings; the review layer
 * never reaches into a source's internals. P10 clash groups, P16 semantic
 * records and P17 comparison reconciliation add or replace an entry in
 * `FINDING_SOURCES` (`sources/index.ts`) instead of editing the card logic.
 */
export interface FindingSource {
  kind: FindingSourceKind;
  collect(models: readonly ReviewModel[]): FindingSourceResult;
}
