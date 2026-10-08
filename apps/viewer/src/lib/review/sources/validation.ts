/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS / information-validation findings: one finding per failed
 * (specification, element) pair of the live report. Immutable saved failure
 * facts are projected separately by saved-validation; count-only older
 * snapshots never acquire invented element rows.
 */

import type { ValidationReport } from '@ifc-lite/ids';
import type { FindingRun, FindingSourceResult, ReviewFinding, ReviewModel, RunGap } from '../types';
import { typeDisciplines } from './disciplines';

export interface ValidationFindingInput { report: ValidationReport; stale: boolean }

function sourceLabel(report: ValidationReport): string {
  return report.source.kind === 'ids' ? report.source.document.info.title || 'IDS' : report.source.ruleSet.name;
}

export function validationFindings(input: ValidationFindingInput | null, models: readonly ReviewModel[]): FindingSourceResult {
  if (!input) return { runs: [], findings: [] };
  const { report, stale } = input;
  const names = new Map(models.map(model => [model.id, model.name]));
  const incomplete: RunGap[] = [
    ...report.specificationResults.filter(spec => spec.error).map(spec => ({ code: 'check-error' as const, detail: `${spec.specification.name}: ${spec.error}` })),
    ...report.specificationResults.filter(spec => spec.setResultsTruncated).map(spec => ({ code: 'sets-truncated' as const, detail: spec.specification.name })),
    ...(stale ? [{ code: 'stale' as const }] : []),
  ];
  const timestamp = report.timestamp instanceof Date && Number.isFinite(report.timestamp.getTime()) ? report.timestamp.toISOString() : null;
  const run: FindingRun = {
    id: 'validation:current', source: 'validation', temporal: 'current', label: sourceLabel(report), capturedAt: timestamp,
    complete: incomplete.length === 0, incomplete,
    models: report.modelInfo.flatMap(info => names.get(info.modelId) ?? []),
  };
  const findings: ReviewFinding[] = [];
  for (const spec of report.specificationResults) {
    for (const entity of spec.entityResults) {
      if (entity.passed) continue;
      const model = models.find(candidate => candidate.id === entity.modelId);
      const globalId = entity.globalId ?? (model ? model.globalIdOf(entity.expressId) : '');
      const storey = model?.storeyOf?.(entity.expressId) ?? null;
      const failed = entity.requirementResults.filter(requirement => requirement.status === 'fail');
      findings.push({
        id: `${run.id}#${spec.specification.id}#${entity.modelId}#${entity.expressId}`,
        lineage: `validation|${run.label}|${spec.specification.id}|${globalId || `${entity.modelId}#${entity.expressId}`}`,
        source: 'validation', run,
        elements: globalId ? [{ globalId, modelId: entity.modelId, modelName: names.get(entity.modelId) ?? null,
          ifcType: entity.entityType, ...(entity.entityName ? { name: entity.entityName } : {}) }] : [],
        nativeStatus: spec.specification.severity === 'warning' ? 'warning' : 'failed',
        title: spec.specification.name,
        detail: failed.slice(0, 8).map(requirement => [requirement.checkedDescription, requirement.failureReason,
          requirement.actualValue !== undefined ? `actual ${requirement.actualValue}` : '',
          requirement.expectedValue !== undefined ? `expected ${requirement.expectedValue}` : ''].filter(Boolean).join(' · ')),
        lifecycle: 'observed', disciplines: typeDisciplines(entity.entityType), storeys: storey ? [storey] : [],
        evidence: { kind: 'validation', specificationId: spec.specification.id, modelId: entity.modelId, expressId: entity.expressId },
      });
    }
  }
  return { runs: [run], findings };
}
