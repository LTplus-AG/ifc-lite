/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isAutomationReportProvenance, type AutomationReportProvenance } from '../flow/report-provenance';
import type { DocumentValidationError } from './types.js';

/** Source identity is evidence about the original run, never a live selector. */
export interface ReportModelScope { name: string; fingerprint?: string }
export interface ReportProvenance {
  savedReportId?: string;
  /** Captured workflow execution identity; travels with the evidence, never a live binding. */
  automation?: AutomationReportProvenance;
  reportModels?: ReportModelScope[];
}

export function validateReportProvenance(block: Record<string, unknown>, at: string, errors: DocumentValidationError[]): void {
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
