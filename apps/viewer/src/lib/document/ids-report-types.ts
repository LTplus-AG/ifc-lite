/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The validation report block's saved shape (#5125, #6372), split out of
 * `types.ts` (which re-exports everything here) to keep that file under its
 * module-size budget.
 *
 * One block kind (`'ids-report'`) serves both validation sources: an IDS run
 * and an information-validation (rule set) run. `sourceKind` says which one
 * produced the snapshot. It is optional and additive (#6372): every block
 * saved before it existed was labelled as IDS, so an absent `sourceKind`
 * reads as `'ids'` and the document format version stays the same.
 */

import { validateBlockTitle, type BlockTitle } from './block-title.js';
import type { DocumentValidationError } from './types.js';
import { validateReportProvenance, type ReportProvenance } from './report-provenance.js';

/** Which engine produced a report block's snapshot; mirrors `ValidationSource['kind']`. */
export type ReportSourceKind = 'ids' | 'rules';

/**
 * One check (IDS specification, or information-validation rule) inside a
 * report block (#5125): the counts and description taken straight off
 * `SpecificationResult` — `shortDescription` is the specification's `name`,
 * `longDescription` its optional `description`, so neither is invented here.
 *
 * The optional fields below are only ever written for an information
 * validation snapshot (#6372); an IDS snapshot keeps its original shape.
 */
export interface IdsReportCheckSummary {
  id: string;
  shortDescription: string;
  longDescription?: string;
  checked: number;
  passed: number;
  failed: number;
  /** 0-100, floor-rounded; 100 when `checked` is 0 (no applicable entities) — matches `SpecificationResult.passRate`. */
  passRate: number;
  rules: IdsReportRuleSummary[];
  /** `'warning'`: this check's failures are warnings, counted apart from failures (#6372). Absent means `'error'`. */
  severity?: 'error' | 'warning';
  /** The engine could not evaluate this check (`SpecificationResult.error`); printed instead of counts (#6372). */
  error?: string;
  /** Set-level results of a `unique` / `aggregate` rule (`SpecificationResult.setResults`, #6372). */
  sets?: IdsReportSetRow[];
  /** The engine capped `sets` before every set was evaluated (`setResultsTruncated`). */
  setsTruncated?: boolean;
  /** How many applicable elements the rule found against its declared cardinality (#6372). */
  cardinality?: IdsReportCardinality;
}

/** A requirement under one IDS specification. Null metrics mean the source
 * report omitted passing entities, so an exact per-rule count is unavailable. */
export interface IdsReportRuleSummary {
  id: string;
  /** Bare attribute / property name (#6470), for the compact layout. Absent in older documents. */
  name?: string;
  shortDescription: string;
  longDescription?: string;
  checked: number;
  passed: number | null;
  failed: number | null;
  passRate: number | null;
}

/** One uniqueness / aggregate group result, as `SetResult` reports it (without its member list). */
export interface IdsReportSetRow {
  /** unique: the shared value; aggregate: fn + subject, e.g. `sum(Qto_….NetFloorArea)`. */
  label: string;
  /** The rendered groupBy key (parent name, storey name…), when the rule groups; `''` is a blank grouping value, not "ungrouped". */
  groupKey?: string;
  actual: string;
  expected: string;
  passed: boolean;
}

/** `IDSCardinalityResult` reduced to its numbers, so every surface words it in its own language. */
export interface IdsReportCardinality {
  passed: boolean;
  actual: number;
  min?: number;
  max?: number;
}

/** `compact`: one bar row per check / requirement. `long`: full requirement text, never truncated. */
export type IdsReportVariant = 'compact' | 'long';
export const IDS_REPORT_VARIANTS: readonly IdsReportVariant[] = ['compact', 'long'];

/**
 * A frozen snapshot of an IDS / information-validation report (#5125, #6372),
 * taken from the live `ValidationReport` when the block is added or refreshed
 * — like a table block's list copy, it travels with the document instead of
 * reading the store, so a saved document still prints the run that produced it.
 */
export interface IdsReportBlock extends ReportProvenance, BlockTitle {
  kind: 'ids-report';
  id: string;
  /** Layout (#6470). Absent in documents saved before it existed, which keep printing the original layout (one truncated line per field) until the author picks one. */
  variant?: IdsReportVariant;
  /**
   * Compact layout only (#6560): print one bar row per specification and leave out its
   * requirement rows. Optional and additive, so the document format version is unchanged;
   * a viewer that supports the document format but predates this field ignores it
   * and prints the full compact report.
   */
  specificationsOnly?: boolean;
  /** Optional ring benchmark (#6552). Absent retains existing document output. */
  benchmarks?: boolean;
  /** Whole-block size, 0.5-2 (#6548); absent is 1. */
  scale?: number;
  /** Which engine produced the snapshot (#6372). Absent means `'ids'`: every block saved before this field existed was labelled IDS. */
  sourceKind?: ReportSourceKind;
  /** IDS document title, or rule-set name, printed in the block's heading. */
  sourceName: string;
  /** When the snapshotted run finished (`ValidationReport.timestamp`, ISO). */
  generatedAt: string;
  /** `failed` excludes warning-severity failures, which `warnings` counts (#6372; absent on IDS snapshots). */
  summary: { checked: number; passed: number; failed: number; passRate: number; warnings?: number };
  checks: IdsReportCheckSummary[];
}

/** The source a report block was snapshotted from; a block saved before #6372 has none and is IDS. */
export function reportBlockSourceKind(block: Pick<IdsReportBlock, 'sourceKind'>): ReportSourceKind {
  return block.sourceKind ?? 'ids';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isRate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

function validateCheckExtras(check: Record<string, unknown>, checkAt: string, errors: DocumentValidationError[]): void {
  if (check.severity !== undefined && check.severity !== 'error' && check.severity !== 'warning') errors.push({ path: `${checkAt}.severity`, message: 'expected error | warning' });
  if (check.error !== undefined && !isString(check.error)) errors.push({ path: `${checkAt}.error`, message: 'expected a string' });
  if (check.setsTruncated !== undefined && typeof check.setsTruncated !== 'boolean') errors.push({ path: `${checkAt}.setsTruncated`, message: 'expected a boolean' });
  if (check.sets !== undefined) {
    if (!Array.isArray(check.sets)) errors.push({ path: `${checkAt}.sets`, message: 'expected an array' });
    else check.sets.forEach((set: unknown, k) => {
      const ok = isRecord(set) && isString(set.label) && isString(set.actual) && isString(set.expected) && typeof set.passed === 'boolean'
        && (set.groupKey === undefined || isString(set.groupKey));
      if (!ok) errors.push({ path: `${checkAt}.sets[${k}]`, message: 'expected { label, actual, expected: strings; passed: boolean; groupKey?: string }' });
    });
  }
  const cardinality = check.cardinality;
  if (cardinality !== undefined) {
    const ok = isRecord(cardinality) && typeof cardinality.passed === 'boolean' && isCount(cardinality.actual)
      && (cardinality.min === undefined || isCount(cardinality.min)) && (cardinality.max === undefined || isCount(cardinality.max));
    if (!ok) errors.push({ path: `${checkAt}.cardinality`, message: 'expected { passed: boolean; actual, min?, max?: non-negative numbers }' });
  }
}

/** Structural check of a report block (#5125, #6372): a finite, non-negative count and a 0-100 pass rate at both the block and every check. */
export function validateIdsReportBlock(block: Record<string, unknown>, at: string, errors: DocumentValidationError[]): void {
  validateReportProvenance(block, at, errors);
  validateBlockTitle(block, at, errors);
  if (block.sourceKind !== undefined && block.sourceKind !== 'ids' && block.sourceKind !== 'rules') errors.push({ path: `${at}.sourceKind`, message: 'expected ids | rules' });
  if (!isString(block.sourceName)) errors.push({ path: `${at}.sourceName`, message: 'expected a string' });
  if (!isString(block.generatedAt)) errors.push({ path: `${at}.generatedAt`, message: 'expected a string' });
  if (block.variant !== undefined && !IDS_REPORT_VARIANTS.includes(block.variant as IdsReportVariant)) errors.push({ path: `${at}.variant`, message: `expected ${IDS_REPORT_VARIANTS.join(' | ')}` });
  if (block.benchmarks !== undefined && typeof block.benchmarks !== 'boolean') errors.push({ path: `${at}.benchmarks`, message: 'expected a boolean' });
  if (block.specificationsOnly !== undefined && typeof block.specificationsOnly !== 'boolean') errors.push({ path: `${at}.specificationsOnly`, message: 'expected a boolean' });
  const summary = block.summary;
  if (!isRecord(summary) || !isCount(summary.checked) || !isCount(summary.passed) || !isCount(summary.failed) || !isRate(summary.passRate)
    || (summary.warnings !== undefined && !isCount(summary.warnings))) {
    errors.push({ path: `${at}.summary`, message: 'expected { checked, passed, failed, warnings?: non-negative numbers; passRate: 0-100 }' });
  }
  if (!Array.isArray(block.checks)) {
    errors.push({ path: `${at}.checks`, message: 'expected an array' });
    return;
  }
  block.checks.forEach((check: unknown, i) => {
    const checkAt = `${at}.checks[${i}]`;
    if (!isRecord(check)) { errors.push({ path: checkAt, message: 'expected an object' }); return; }
    if (!isString(check.id) || check.id.length === 0) errors.push({ path: `${checkAt}.id`, message: 'expected a non-empty string' });
    if (!isString(check.shortDescription)) errors.push({ path: `${checkAt}.shortDescription`, message: 'expected a string' });
    if (check.longDescription !== undefined && !isString(check.longDescription)) errors.push({ path: `${checkAt}.longDescription`, message: 'expected a string' });
    if (!isCount(check.checked) || !isCount(check.passed) || !isCount(check.failed)) errors.push({ path: `${checkAt}`, message: 'expected checked/passed/failed: non-negative numbers' });
    if (!isRate(check.passRate)) errors.push({ path: `${checkAt}.passRate`, message: 'expected a number between 0 and 100' });
    validateCheckExtras(check, checkAt, errors);
    if (!Array.isArray(check.rules)) {
      errors.push({ path: `${checkAt}.rules`, message: 'expected an array' });
      return;
    }
    check.rules.forEach((rule: unknown, j) => {
      const ruleAt = `${checkAt}.rules[${j}]`;
      if (!isRecord(rule)) { errors.push({ path: ruleAt, message: 'expected an object' }); return; }
      if (!isString(rule.id) || rule.id.length === 0) errors.push({ path: `${ruleAt}.id`, message: 'expected a non-empty string' });
      if (!isString(rule.shortDescription)) errors.push({ path: `${ruleAt}.shortDescription`, message: 'expected a string' });
      if (rule.name !== undefined && !isString(rule.name)) errors.push({ path: `${ruleAt}.name`, message: 'expected a string' });
      if (rule.longDescription !== undefined && !isString(rule.longDescription)) errors.push({ path: `${ruleAt}.longDescription`, message: 'expected a string' });
      if (!isCount(rule.checked)) errors.push({ path: `${ruleAt}.checked`, message: 'expected a non-negative number' });
      const unavailable = rule.passed === null && rule.failed === null && rule.passRate === null;
      if (!unavailable && (!isCount(rule.passed) || !isCount(rule.failed) || !isRate(rule.passRate))) {
        errors.push({ path: ruleAt, message: 'expected passed/failed: non-negative numbers and passRate: 0-100, or all null' });
      }
    });
  });
}
