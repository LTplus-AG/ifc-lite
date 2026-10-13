/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isAutomationReportProvenance, sameReportEvidence, type AutomationReportProvenance } from './portable-automation-provenance.js';
import { validateIdsReportBlock, type IdsReportBlock } from './portable-ids-report.js';
import { validateManualReportBlock, type ManualReportBlock } from './portable-manual-report.js';
import type { PortableReportValidationError as DocumentValidationError } from './portable-report-metadata.js';

export type ValidationReportSnapshot = IdsReportBlock | ManualReportBlock;
export interface SavedValidationReport {
  id: string;
  name: string;
  snapshot: ValidationReportSnapshot;
  automation?: AutomationReportProvenance;
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
