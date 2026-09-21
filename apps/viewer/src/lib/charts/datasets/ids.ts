/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `ids` chart dataset (#3944): one row per (specification, entity)
 * result of the last IDS validation — pass / fail per specification is the
 * delivery chart every BEP asks for, and the failing facet says what kind of
 * gap dominates.
 */
import type { ChartDataset, ChartDatasetColumn, ChartDatasetRow } from '@ifc-lite/charts';
import type { ViewerState } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';

export const IDS_COLUMNS = {
  specification: 'Specification',
  result: 'Result',
  entityType: 'EntityType',
  failedFacet: 'FailedFacet',
  model: 'Model',
  // Additive columns (#5138 §7) — IDS rows carry the failed requirement's
  // label / failure text / a literal 'ids'; the rule-set engine (PR 3
  // onward) populates the same columns from `SetResult`/`FailureReasonCode`.
  requirement: 'Requirement',
  reason: 'Reason',
  source: 'Source',
} as const;

export const IDS_DATASET_COLUMNS: ChartDatasetColumn[] = [
  { id: IDS_COLUMNS.specification, label: 'Specification', kind: 'category' },
  { id: IDS_COLUMNS.result, label: 'Result (pass / fail)', kind: 'category' },
  { id: IDS_COLUMNS.entityType, label: 'Entity type', kind: 'category' },
  { id: IDS_COLUMNS.failedFacet, label: 'Failing facet', kind: 'category' },
  { id: IDS_COLUMNS.model, label: 'Model', kind: 'category' },
  { id: IDS_COLUMNS.requirement, label: 'Requirement', kind: 'category' },
  { id: IDS_COLUMNS.reason, label: 'Reason', kind: 'category' },
  { id: IDS_COLUMNS.source, label: 'Source', kind: 'category' },
];

export type IdsDatasetState = Pick<ViewerState, 'idsValidationReport' | 'models' | 'activeModelId'>;

export function buildIdsDataset(state: IdsDatasetState): ChartDataset {
  const report = state.idsValidationReport;
  const rows: ChartDatasetRow[] = [];
  if (report) {
    for (const spec of report.specificationResults) {
      for (const entity of spec.entityResults) {
        // Single-model results are keyed 'legacy'; fold onto the active model.
        const modelId = state.models.has(entity.modelId) ? entity.modelId : (state.activeModelId ?? entity.modelId);
        const failed = entity.requirementResults.find((r) => r.status === 'fail');
        rows.push({
          ids: [toGlobalIdFromModels(state.models, modelId, entity.expressId)],
          values: [
            spec.specification.name,
            entity.passed ? 'pass' : 'fail',
            entity.entityType,
            failed?.facetType ?? '',
            state.models.get(modelId)?.name ?? modelId,
            failed?.requirement.label ?? '',
            failed?.failureReason ?? '',
            report.source.kind,
          ],
        });
      }
    }
  }
  return { source: 'ids', columns: IDS_DATASET_COLUMNS, rows, fingerprint: `ids:${report?.timestamp?.getTime?.() ?? 0}:${rows.length}` };
}
