/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Immutable validation evidence (#6500). Only report snapshots are saved;
 * runtime entity ids and live model/store references never travel with them. */
import { isAutomationReportProvenance, sameReportEvidence, type AutomationReportProvenance } from '../../flow/report-provenance';
import type { ValidationReport } from '@ifc-lite/ids';
import { idsReportBlockFromReport } from '../../document/ids-report.js';
import { validateIdsReportBlock, type IdsReportBlock } from '../../document/ids-report-types.js';
import { validateManualReportBlock, type ManualReportBlock } from '../../document/manual-report-types.js';
import type { DocumentValidationError } from '../../document/types.js';
import { rememberReportModelScope, reportModelScope, type ReportModelScope } from '../../document/report-provenance.js';

export type ValidationReportSnapshot = IdsReportBlock | ManualReportBlock;
export interface SavedValidationReport {
  id: string;
  name: string;
  snapshot: ValidationReportSnapshot;
  automation?: AutomationReportProvenance;
}
/** Names, scope and timestamp distinguish repeated runs of one check. */
export function savedReportLabel(entry: SavedValidationReport): string {
  return [entry.name, entry.snapshot.reportModels?.map((model) => model.name).join(', '), entry.snapshot.generatedAt].filter(Boolean).join(' · ');
}

export type ReportScopeModel = { name: string; sourceFingerprint?: string | null };

/** The report's evaluated modelInfo is authoritative, including models with
 * no applicable entities; do not infer the scope from failed entity rows. */
export function validationReportSnapshot(report: ValidationReport, models: ReadonlyMap<string, ReportScopeModel>, id: string): IdsReportBlock {
  const reportModels: ReportModelScope[] = report.modelInfo.map(({ modelId }) => {
    const model = models.get(modelId);
    return reportModelScope(model?.name, modelId, model?.sourceFingerprint);
  });
  rememberReportModelScope(report, reportModels);
  return idsReportBlockFromReport(report, id);
}

/** Copy the evidence into a document. Later runs, history edits and deletion
 * cannot change an already inserted block; its own id always wins. */
export function savedReportBlock(entry: SavedValidationReport, blockId: string): ValidationReportSnapshot {
  return { ...structuredClone(entry.snapshot), id: blockId, savedReportId: entry.id,
    ...(entry.automation ? { automation: structuredClone(entry.automation) } : {}),
  };
}

/** Normalize earlier envelope-only provenance without changing original evidence dates. */
export function savedReportWithProvenance(entry: SavedValidationReport): SavedValidationReport {
  const automation = entry.automation ?? entry.snapshot.automation;
  return { ...structuredClone(entry), ...(automation ? { automation: structuredClone(automation),
    snapshot: { ...structuredClone(entry.snapshot), automation: structuredClone(automation) } } : {}) };
}

export function validateSavedReport(value: unknown): value is SavedValidationReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string' || !entry.name.trim()) return false;
  if (entry.automation !== undefined && !isAutomationReportProvenance(entry.automation)) return false;
  const raw = entry.snapshot;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const block = raw as Record<string, unknown>;
  if (typeof block.id !== 'string' || !block.id || typeof block.generatedAt !== 'string' || !Number.isFinite(Date.parse(block.generatedAt))) return false;
  if (entry.automation !== undefined && block.automation !== undefined && !sameReportEvidence(entry.automation, block.automation)) return false;
  const errors: DocumentValidationError[] = [];
  if (block.kind === 'ids-report') validateIdsReportBlock(block, 'snapshot', errors);
  else if (block.kind === 'manual-report') validateManualReportBlock(block, 'snapshot', errors);
  else return false;
  return errors.length === 0;
}

export function newSavedReport(snapshot: ValidationReportSnapshot, name?: string, automation?: AutomationReportProvenance): SavedValidationReport {
  const id = `validation-report-${crypto.randomUUID()}`;
  const source = snapshot.kind === 'manual-report' ? snapshot.checklistName : snapshot.sourceName;
  const metadata = automation ?? snapshot.automation;
  return { id, name: name?.trim() || source.trim() || 'Validation report',
    ...(metadata ? { automation: structuredClone(metadata) } : {}),
    snapshot: { ...structuredClone(snapshot), id, savedReportId: id, ...(metadata ? { automation: structuredClone(metadata) } : {}) },
  };
}
