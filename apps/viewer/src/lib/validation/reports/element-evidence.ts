/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7091: bounded immutable failure evidence; runtime ids never travel with a saved report. */
import type { ValidationReport } from '@ifc-lite/ids';
import { xxhash64Hex } from '@ifc-lite/cache';
import { failingSignature, validationSourceDigest, validationSpecificationDigest } from '../../compare/run-reconcile-validation';
import type { ReportModelScope } from '../../document/report-provenance';

import { SAVED_VALIDATION_LIMITS, isSavedValidationElement,
  type SavedValidationElement, type SavedValidationDefinition, type SavedValidationElements } from '@ifc-lite/sdk/review';
export { validateSavedValidationElements, type SavedValidationElement, type SavedValidationDefinition,
  type SavedValidationElements } from '@ifc-lite/sdk/review';
export const SAVED_ELEMENT_LIMIT = SAVED_VALIDATION_LIMITS.rows;
const SOURCE_ROW_LIMIT = SAVED_VALIDATION_LIMITS.sourceRows;
const TOTAL_BYTE_LIMIT = SAVED_VALIDATION_LIMITS.totalBytes;
const TEXT_LIMIT = SAVED_VALIDATION_LIMITS.text;
const CHECK_LIMIT = SAVED_VALIDATION_LIMITS.checks;
const DEFINITION_BYTE_LIMIT = SAVED_VALIDATION_LIMITS.definitionBytes;
const evaluatedElements = new WeakMap<ValidationReport, SavedValidationElements>();
const text = (value: unknown, max: number = TEXT_LIMIT): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

/** Portable digest of native definition text; equal text always yields an equal digest. */
export function evidenceDigest(text: string): string {
  return `xxh64:${xxhash64Hex(new TextEncoder().encode(text))}`;
}

/** The checked definition of a native report; null when unknown, ambiguous or beyond portable bounds. */
export function validationDefinition(report: ValidationReport): SavedValidationDefinition | null {
  const source = validationSourceDigest(report);
  const ids = report.specificationResults.map(spec => spec.specification.id);
  if (source === null || ids.length > CHECK_LIMIT || new Set(ids).size !== ids.length || !ids.every(id => text(id))) return null;
  const definition = { source: evidenceDigest(source),
    checks: report.specificationResults.map(spec => ({ id: spec.specification.id, digest: evidenceDigest(validationSpecificationDigest(report, spec)) })) };
  return new TextEncoder().encode(JSON.stringify(definition)).byteLength <= DEFINITION_BYTE_LIMIT ? definition : null;
}

/** Capture native entity failures, retaining explicit unknown identities and cap disclosures. */
export function captureValidationElements(report: ValidationReport, scopes?: readonly ReportModelScope[], globalIdOf?: (modelId: string, expressId: number) => string | undefined): SavedValidationElements {
  const captured = evaluatedElements.get(report);
  if (captured) return structuredClone(captured);
  const names = new Map(report.modelInfo.map((model, index) => [model.modelId, scopes?.[index]]));
  const rows: SavedValidationElement[] = [];
  const gaps = new Set<string>();
  const definition = validationDefinition(report);
  if (!definition) gaps.add('The native check definition was not recorded; saved rows cannot be re-examined');
  // The definition travels inside the same bounded evidence, so its bytes are reserved first.
  let scanned = 0, observed = 0, omitted = 0, retainedBytes = definition ? new TextEncoder().encode(JSON.stringify(definition)).byteLength : 0;
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
        title: spec.specification.name, nativeStatus: spec.specification.severity === 'warning' ? 'warning' : 'failed', detail,
        signature: evidenceDigest(failingSignature(entity)) };
      if (!row.GlobalId || !modelName) gaps.add('Some saved rows lack durable element or model identity');
      const bytes = !oversized && isSavedValidationElement(row) ? new TextEncoder().encode(JSON.stringify(row)).byteLength : Infinity;
      if (rows.length >= SAVED_ELEMENT_LIMIT || retainedBytes + bytes > TOTAL_BYTE_LIMIT - 16_384) {
        omitted++; gaps.add('Failure rows exceeding saved evidence limits were omitted');
      } else { rows.push(row); retainedBytes += bytes; }
    }
    if (failures !== spec.failedCount) gaps.add('Native failure counts and retained entity rows differ');
  }
  return { version: 1, rows, observed, omitted, gaps: [...gaps], ...(definition ? { definition } : {}) };
}

/** Resolve missing identities once against the evaluated stores, never a later scene. */
export function rememberValidationElements(report: ValidationReport, scopes: readonly ReportModelScope[], globalIdOf: (modelId: string, expressId: number) => string | undefined): void {
  if (!evaluatedElements.has(report)) evaluatedElements.set(report, captureValidationElements(report, scopes, globalIdOf));
}
