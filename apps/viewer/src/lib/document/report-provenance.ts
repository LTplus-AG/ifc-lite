/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isAutomationReportProvenance, type AutomationReportProvenance } from '../flow/report-provenance';
import type { DocumentValidationError } from './types.js';
import { blockTitleFields, type BlockTitle } from './block-title.js';

/** Source identity is evidence about the original run, never a live selector. */
export interface ReportModelScope { name: string; fingerprint?: string }
/** The author's choice to print or omit a report's stamp rows (#6566, #6678).
 * Absent means shown, so every document saved before the choice printed the same. */
export interface ReportStampChoice {
  showStamp?: boolean;
}
export interface ReportProvenance extends ReportStampChoice {
  savedReportId?: string;
  /** Captured workflow execution identity; travels with the evidence, never a live binding. */
  automation?: AutomationReportProvenance;
  reportModels?: ReportModelScope[];
}

export function validateReportProvenance(block: Record<string, unknown>, at: string, errors: DocumentValidationError[]): void {
  if (block.showStamp !== undefined && typeof block.showStamp !== 'boolean') errors.push({ path: `${at}.showStamp`, message: 'expected a boolean' });
  if (block.automation !== undefined && !isAutomationReportProvenance(block.automation)) {
    errors.push({ path: `${at}.automation`, message: 'expected valid workflow report provenance' });
  }
  if (block.savedReportId !== undefined && (typeof block.savedReportId !== 'string' || !block.savedReportId)) {
    errors.push({ path: `${at}.savedReportId`, message: 'expected a non-empty string' });
  }
  if (block.reportModels !== undefined && (!Array.isArray(block.reportModels) || !block.reportModels.every((model: unknown) => {
    if (typeof model !== 'object' || model === null || Array.isArray(model)) return false;
    const m = model as Record<string, unknown>;
    return typeof m.name === 'string' && m.name.trim().length > 0 && (m.fingerprint === undefined || (typeof m.fingerprint === 'string' && m.fingerprint.length > 0));
  }))) errors.push({ path: `${at}.reportModels`, message: 'expected non-empty model names and optional non-empty fingerprints' });
}

export function reportScopeText(block: ReportProvenance): string {
  return block.reportModels?.map((model) => model.name).join(', ') ?? '';
}

/** What every report block stamps under its title, for the preview and the PDF
 * alike: when the run was recorded, the model it was recorded against (manual
 * reports only: the other kinds carry no single model) and the evaluated-model
 * scope. All three are values the block already holds, none is read at render time. */
export interface ReportStamp { modelName: string | undefined; generatedAt: string; models: string }

/** `null` when the author hid the stamp. The frozen identity and timestamp stay
 * in the block either way. */
export function reportStamp(block: ReportProvenance & { generatedAt: string; modelName?: string }): ReportStamp | null {
  return block.showStamp === false ? null : { modelName: block.modelName, generatedAt: block.generatedAt, models: reportScopeText(block) };
}

/** The author's choices every report kind has: the heading (text and style,
 * from `blockTitleFields`, the one list of heading fields), size and stamp.
 * Kept whenever evidence is replaced, including when the replacement is of
 * another kind (IDS to manual and back), where layout and benchmarks
 * deliberately take the new evidence's defaults. A choice shared by all kinds
 * is added here. Unset choices are carried as explicit `undefined`, so a field
 * cleared on the destination is not resurrected from the snapshot. */
export function keepCommonReportChoices<T extends ReportStampChoice & BlockTitle & { scale?: number }>(current: ReportStampChoice & BlockTitle & { scale?: number }, snapshot: T): T {
  return { ...snapshot, ...blockTitleFields(current), scale: current.scale, showStamp: current.showStamp };
}

/** Replacing a report's evidence (live refresh, choosing a saved report) keeps
 * the destination block's identity and everything its author chose to show:
 * heading, layout, benchmarks, specifications-only, stamp and size. One rule for the manual and the
 * IDS / information-validation kinds, so their refresh paths cannot drift. */
export function replaceReportSnapshot<B extends ReportStampChoice & BlockTitle & { id: string; variant?: string; benchmarks?: boolean; scale?: number; specificationsOnly?: boolean }>(current: B, snapshot: B): B {
  return { ...keepCommonReportChoices(current, snapshot), id: current.id, variant: current.variant, benchmarks: current.benchmarks, specificationsOnly: current.specificationsOnly };
}

/** Keep exact nonblank model names; unnamed sources use their captured
 * identity so a saved scope can never claim an invisible model (#6500). */
export function reportModelScope(name: string | undefined, fallback: string, fingerprint?: string | null): ReportModelScope {
  return { name: name?.trim() ? name : fallback, ...(fingerprint ? { fingerprint } : {}) };
}

// Runtime reports outlive their original loaded model. Capture names once at
// completed evaluation, just like analysis staleness stamps; every document
// conversion gets an independent copy rather than looking at today's models.
const evaluatedScopes = new WeakMap<object, ReportModelScope[]>();
export function rememberReportModelScope(report: object, scope: readonly ReportModelScope[]): void {
  if (!evaluatedScopes.has(report)) evaluatedScopes.set(report, scope.map((model) => ({ ...model })));
}
export function capturedReportModelScope(report: object): ReportModelScope[] | undefined {
  return evaluatedScopes.get(report)?.map((model) => ({ ...model }));
}
