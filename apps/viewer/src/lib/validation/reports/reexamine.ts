/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-examine saved validation failure rows through a current native run (#7371).
 *
 * The saved side is only what #7091 captured: failure rows with GlobalId,
 * durable model name, source fingerprint and failed-requirement signature,
 * plus the definition digest of what the run checked. Nothing here
 * re-validates or synthesizes a report. A saved row is compared only when
 * the current run checked exactly the same definition over exactly the same
 * evaluated model sources and its freshness is known and current. Then, per
 * row, the run reconciler's rules apply: an explicit failing result persists
 * (or changed requirements), an explicit passing result is a resolution
 * candidate only when the current run is complete, and anything else
 * (deleted, unevaluated, duplicated, errored) stays not evaluated.
 */

import type { ValidationReport } from '@ifc-lite/ids';
import { capturedReportModelScope } from '../../document/report-provenance';
import type { IdsReportBlock } from '../../document/ids-report-types';
import { byGlobalId, failingSignature, hasGap } from '../../compare/run-reconcile-validation';
import { evidenceDigest, validationDefinition, type SavedValidationElement } from './element-evidence';

/** A current native validation run as Review holds it. */
export interface CurrentValidationRun {
  report: ValidationReport;
  /** Edited since the run; a run without an analysis stamp has unknown freshness. */
  stale: boolean;
  stamped: boolean;
}

/** Why a saved row was not compared. Codes are stable; Review prints them as native detail. */
export type ReexaminationGap =
  | 'noCurrentRun' | 'definitionNotRecorded' | 'definitionUnknown' | 'definitionDiffers'
  | 'runFreshnessUnknown' | 'runStale' | 'scopeUnknown' | 'scopeDiffers'
  | 'identityUnavailable' | 'modelAmbiguous' | 'identityAmbiguous' | 'specificationError'
  | 'entityNotEvaluated' | 'runIncomplete';

export type RowReexamination =
  | { state: 'persisting' | 'changed' | 'resolved' }
  | { state: 'notEvaluated'; reason: ReexaminationGap };

export type Reexamination =
  | { compatible: true; rows: ReadonlyMap<string, RowReexamination> }
  | { compatible: false; reasons: ReexaminationGap[] };

type Scope = Array<{ name: string; fingerprint?: string }>;
const scopeKey = (scope: Scope) => JSON.stringify(scope.map(model => [model.name, model.fingerprint ?? null]).sort());

/** The current run's evaluated sources, captured when it completed; unnamed sources have no durable owner. */
function currentScope(report: ValidationReport): Array<{ modelId: string; name: string | null; fingerprint?: string }> | null {
  const scope = capturedReportModelScope(report);
  if (!scope || scope.length !== report.modelInfo.length) return null;
  return report.modelInfo.map(({ modelId }, index) => ({ modelId,
    name: scope[index].name !== modelId ? scope[index].name : null, fingerprint: scope[index].fingerprint }));
}

/** A complete current run evaluated every applicable entity of every check without error or cap. */
const definitions = new WeakMap<ValidationReport, ReturnType<typeof validationDefinition>>();
function currentDefinition(report: ValidationReport) {
  if (!definitions.has(report)) definitions.set(report, validationDefinition(report));
  return definitions.get(report) ?? null;
}

const completeRun = (report: ValidationReport) => report.specificationResults.every(spec => !hasGap(spec) && !spec.setResultsTruncated);

export function reexamineSavedValidation(snapshot: IdsReportBlock, current: CurrentValidationRun | null): Reexamination {
  const evidence = snapshot.elementEvidence;
  const reasons: ReexaminationGap[] = [];
  if (!current) return { compatible: false, reasons: ['noCurrentRun'] };
  const { report } = current;
  const saved = evidence?.definition;
  const live = currentDefinition(report);
  if (!saved) reasons.push('definitionNotRecorded');
  else if (!live) reasons.push('definitionUnknown');
  else if (saved.source !== live.source) reasons.push('definitionDiffers');
  if (!current.stamped) reasons.push('runFreshnessUnknown');
  else if (current.stale) reasons.push('runStale');
  const scope = currentScope(report);
  const savedScope = snapshot.reportModels;
  if (!scope || !savedScope || [...scope, ...savedScope].some(model => !model.name || !model.fingerprint)) reasons.push('scopeUnknown');
  else if (scopeKey(savedScope) !== scopeKey(scope.map(model => ({ name: model.name ?? '', fingerprint: model.fingerprint })))) reasons.push('scopeDiffers');
  if (reasons.length || !evidence || !saved || !live || !scope || !savedScope) return { compatible: false, reasons };

  const complete = completeRun(report);
  const specs = new Map(report.specificationResults.map(spec => [spec.specification.id, spec]));
  const savedChecks = new Map(saved.checks.map(check => [check.id, check.digest]));
  const liveChecks = new Map(live.checks.map(check => [check.id, check.digest]));
  const ownerKey = (row: SavedValidationElement) => JSON.stringify([row.specificationId, row.modelName, row.GlobalId]);
  const owners = new Map<string, number>();
  for (const row of evidence.rows) owners.set(ownerKey(row), (owners.get(ownerKey(row)) ?? 0) + 1);
  const rows = new Map<string, RowReexamination>();
  const skip = (row: SavedValidationElement, reason: ReexaminationGap) => rows.set(row.id, { state: 'notEvaluated', reason });
  for (const row of evidence.rows) {
    if (!row.GlobalId || !row.modelName || !row.modelFingerprint || !row.signature) { skip(row, 'identityUnavailable'); continue; }
    const models = scope.filter(model => model.name === row.modelName);
    if (models.length !== 1 || savedScope.filter(model => model.name === row.modelName).length !== 1
      || models[0].fingerprint !== row.modelFingerprint) { skip(row, 'modelAmbiguous'); continue; }
    // Equal source digests imply equal checks; a missing check is still never assumed equal.
    if (savedChecks.get(row.specificationId) === undefined || savedChecks.get(row.specificationId) !== liveChecks.get(row.specificationId)) {
      skip(row, 'definitionDiffers'); continue;
    }
    const spec = specs.get(row.specificationId);
    if (!spec || spec.error) { skip(row, 'specificationError'); continue; }
    const results = byGlobalId(spec, models[0].modelId);
    if (owners.get(ownerKey(row)) !== 1 || results.duplicated.has(row.GlobalId)) { skip(row, 'identityAmbiguous'); continue; }
    const next = results.results.get(row.GlobalId);
    if (!next) { skip(row, 'entityNotEvaluated'); continue; }
    if (!next.passed) rows.set(row.id, { state: evidenceDigest(failingSignature(next)) === row.signature ? 'persisting' : 'changed' });
    else if (complete) rows.set(row.id, { state: 'resolved' });
    else skip(row, 'runIncomplete');
  }
  return { compatible: true, rows };
}
