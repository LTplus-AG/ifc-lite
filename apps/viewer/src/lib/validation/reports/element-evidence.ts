/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7091: bounded immutable failure evidence; runtime ids never travel with a saved report. */
import type { ValidationReport } from '@ifc-lite/ids';
import type { ReportModelScope } from '../../document/report-provenance';
import type { DocumentValidationError } from '../../document/types';

export const SAVED_ELEMENT_LIMIT = 2_000;
const SOURCE_ROW_LIMIT = 50_000;
const ROW_BYTE_LIMIT = 8_192;
const TOTAL_BYTE_LIMIT = 1_048_576;
const TEXT_LIMIT = 1_024;
const EVIDENCE_FIELDS = new Set(['version', 'rows', 'observed', 'omitted', 'gaps']);
const ROW_FIELDS = new Set(['id', 'specificationId', 'GlobalId', 'modelName', 'modelFingerprint', 'ifcType', 'Name', 'title', 'nativeStatus', 'detail']);
const evaluatedElements = new WeakMap<ValidationReport, SavedValidationElements>();

export interface SavedValidationElement {
  /** Identity within this immutable capture, independent of ephemeral express/model ids. */
  id: string;
  specificationId: string;
  GlobalId: string | null;
  modelName: string | null;
  modelFingerprint?: string;
  ifcType: string;
  Name?: string;
  title: string;
  nativeStatus: 'failed' | 'warning';
  detail: string[];
}
export interface SavedValidationElements {
  version: 1;
  rows: SavedValidationElement[];
  /** Failed/warning entity rows encountered before the scan cap, not a population total. */
  observed: number;
  /** Encountered failure rows that snapshot limits could not retain. */
  omitted: number;
  /** Native source coverage and snapshot-limit disclosures, never inferred resolution. */
  gaps: string[];
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = TEXT_LIMIT): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function validRow(value: unknown): value is SavedValidationElement {
  if (!record(value) || Object.keys(value).some(key => !ROW_FIELDS.has(key)) || !text(value.id, 128) || !text(value.specificationId) || (value.GlobalId !== null && !text(value.GlobalId, 200))
    || (value.modelName !== null && !text(value.modelName)) || (value.modelFingerprint !== undefined && !text(value.modelFingerprint, 256))
    || !text(value.ifcType, 200) || (value.Name !== undefined && (typeof value.Name !== 'string' || value.Name.length > TEXT_LIMIT))
    || typeof value.title !== 'string' || value.title.length > TEXT_LIMIT
    || (value.nativeStatus !== 'failed' && value.nativeStatus !== 'warning') || !Array.isArray(value.detail)
    || value.detail.length > 8 || !value.detail.every(line => text(line))) return false;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= ROW_BYTE_LIMIT;
}

export function validateSavedValidationElements(value: unknown, at: string, errors: DocumentValidationError[]): void {
  if (!record(value) || Object.keys(value).some(key => !EVIDENCE_FIELDS.has(key)) || value.version !== 1 || !Array.isArray(value.rows) || value.rows.length > SAVED_ELEMENT_LIMIT
    || !count(value.observed) || !count(value.omitted) || value.observed !== value.rows.length + value.omitted
    || !Array.isArray(value.gaps) || value.gaps.length > 16 || !value.gaps.every(gap => text(gap))
    || !value.rows.every(validRow) || new Set(value.rows.map(row => row.id)).size !== value.rows.length
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > TOTAL_BYTE_LIMIT) {
    errors.push({ path: at, message: 'expected bounded version-1 saved validation element evidence' });
  }
}

/** Capture native entity failures, retaining explicit unknown identities and cap disclosures. */
export function captureValidationElements(report: ValidationReport, scopes?: readonly ReportModelScope[], globalIdOf?: (modelId: string, expressId: number) => string | undefined): SavedValidationElements {
  const captured = evaluatedElements.get(report);
  if (captured) return structuredClone(captured);
  const names = new Map(report.modelInfo.map((model, index) => [model.modelId, scopes?.[index]]));
  const rows: SavedValidationElement[] = [];
  const gaps = new Set<string>();
  let scanned = 0, observed = 0, omitted = 0, retainedBytes = 0;
  outer: for (const spec of report.specificationResults) {
    if (spec.error) gaps.add('The native source contains an unevaluable check');
    if (spec.passedCount + spec.failedCount < spec.applicableCount) gaps.add('The native evaluated element count is smaller than its applicable population');
    if (spec.entityResults.length < spec.passedCount + spec.failedCount) gaps.add('The native source omitted some evaluated entity rows');
    if (spec.setResultsTruncated) gaps.add('The native source capped set-level results');
    let failures = 0;
    for (const entity of spec.entityResults) {
      if (++scanned > SOURCE_ROW_LIMIT) { gaps.add('The saved evidence scan was capped; remaining failure count is unknown'); break outer; }
      if (entity.passed) continue;
      failures++;
      const ordinal = observed++;
      if (rows.length >= SAVED_ELEMENT_LIMIT) { omitted++; gaps.add('Failure rows exceeding saved evidence limits were omitted'); continue; }
      const scope = names.get(entity.modelId);
      // A scope fallback equal to the runtime id cannot establish a durable model name.
      const modelName = scope?.name && scope.name !== entity.modelId ? scope.name : null;
      const detail: string[] = [];
      let oversized = false;
      if (entity.requirementResults.length > 256) gaps.add('Saved requirement inspection was capped at 256 per element');
      for (const check of entity.requirementResults.slice(0, 256)) {
        if (check.status !== 'fail') continue;
        if (detail.length === 8) { gaps.add('Saved requirement details were capped at eight per element'); break; }
        const fields = [check.checkedDescription, check.failureReason, check.actualValue, check.expectedValue];
        if (fields.some(field => field !== undefined && field.length > TEXT_LIMIT)) { oversized = true; break; }
        const line = [check.checkedDescription, check.failureReason,
          check.actualValue !== undefined ? `actual ${check.actualValue}` : '',
          check.expectedValue !== undefined ? `expected ${check.expectedValue}` : ''].filter(Boolean).join(' · ');
        if (line) detail.push(line);
      }
      const row: SavedValidationElement = { id: `failure-${ordinal}`, specificationId: spec.specification.id,
        GlobalId: entity.globalId || globalIdOf?.(entity.modelId, entity.expressId) || null, modelName, ...(scope?.fingerprint ? { modelFingerprint: scope.fingerprint } : {}),
        ifcType: entity.entityType, ...(entity.entityName !== undefined ? { Name: entity.entityName } : {}),
        title: spec.specification.name, nativeStatus: spec.specification.severity === 'warning' ? 'warning' : 'failed', detail };
      if (!row.GlobalId || !modelName) gaps.add('Some saved rows lack durable element or model identity');
      const bytes = !oversized && validRow(row) ? new TextEncoder().encode(JSON.stringify(row)).byteLength : Infinity;
      if (rows.length >= SAVED_ELEMENT_LIMIT || retainedBytes + bytes > TOTAL_BYTE_LIMIT - 16_384) {
        omitted++; gaps.add('Failure rows exceeding saved evidence limits were omitted');
      } else { rows.push(row); retainedBytes += bytes; }
    }
    if (failures !== spec.failedCount) gaps.add('Native failure counts and retained entity rows differ');
  }
  return { version: 1, rows, observed, omitted, gaps: [...gaps] };
}

/** Resolve missing identities once against the evaluated stores, never a later scene. */
export function rememberValidationElements(report: ValidationReport, scopes: readonly ReportModelScope[], globalIdOf: (modelId: string, expressId: number) => string | undefined): void {
  if (!evaluatedElements.has(report)) evaluatedElements.set(report, captureValidationElements(report, scopes, globalIdOf));
}
