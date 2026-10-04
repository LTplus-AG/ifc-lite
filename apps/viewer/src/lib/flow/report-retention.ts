/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isSavedComparison, type SavedComparison } from '../compare/savedComparisons';
import { savedReportWithProvenance, validateSavedReport, type SavedValidationReport } from '../validation/reports/history';
import type { ValidationReportsSlice } from '@/store/slices/validationReportsSlice';
import type { SavedComparisonsSlice } from '@/store/slices/savedComparisonsSlice';
import { sameReportEvidence } from './report-provenance';

export interface ReportRetentionResult {
  id: string;
  status: 'saved' | 'memory-only' | 'duplicate';
  warnings: string[];
}
export interface ReportRetentionHost {
  getState(): ValidationReportsSlice & SavedComparisonsSlice;
}
const outcome = (id: string, persisted: boolean, duplicate: boolean): ReportRetentionResult => ({
  id, status: persisted ? duplicate ? 'duplicate' : 'saved' : 'memory-only',
  warnings: persisted ? [] : ['Report remains in memory because browser storage refused the write. Retry saving or download it before closing this session.'],
});

/** Supplied result IDs make saving within one run idempotent; a new run supplies new IDs. */
export async function retainValidationReport(entry: SavedValidationReport, host: ReportRetentionHost): Promise<ReportRetentionResult> {
  if (!validateSavedReport(entry)) throw new Error('Invalid validation evidence');
  entry = savedReportWithProvenance(entry);
  const state = host.getState();
  const existing = state.savedValidationReports.find((saved) => saved.id === entry.id);
  if (existing && !sameReportEvidence(savedReportWithProvenance(existing), entry)) throw new Error(`Validation evidence ID collision: ${entry.id}`);
  if (await state.saveValidationReportEntry(entry) === null) throw new Error('Validation evidence was refused');
  return outcome(entry.id, host.getState().validationReportsStorage.items[entry.id] === 'saved', !!existing);
}

export async function retainComparisonReport(entry: SavedComparison, host: ReportRetentionHost): Promise<ReportRetentionResult> {
  if (!isSavedComparison(entry)) throw new Error('Invalid comparison evidence');
  const state = host.getState();
  const existing = state.savedComparisons.find((saved) => saved.id === entry.id);
  if (existing && !sameReportEvidence(existing, entry)) throw new Error(`Comparison evidence ID collision: ${entry.id}`);
  return outcome(entry.id, await state.saveComparison(entry), !!existing);
}
