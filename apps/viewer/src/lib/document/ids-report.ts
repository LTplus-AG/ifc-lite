/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An IDS report block's content (#5125): a frozen snapshot of a
 * `ValidationReport`, taken from `useViewerStore().idsValidationReport`
 * when the block is added or refreshed. Reuses the report's own numbers —
 * `calculateSummary` for the top summary (it already floors the pass rate
 * and falls back to 100 rather than NaN on zero checked entities, see
 * `packages/ids/src/validation/validator.ts`), `SpecificationResult`'s own
 * `passRate` per check — so nothing here recomputes validation math.
 *
 * Scope (#5125): summary and top-level check list only, no nested
 * per-requirement ("rule") rollup. `RequirementSummary` (the per-requirement
 * type inside `RequirementResult`) carries only `label`, not a separate
 * short/long description, and the per-entity `requirementResults` this
 * would have to be aggregated from are only guaranteed complete when the
 * report was built with `includePassingEntities: true` (the viewer's own
 * IDS panel run uses that; a BCF export can use a failures-only run) — so a
 * requirement rollup built from `entityResults` here could silently
 * undercount `checked` for a report from a source that filtered it. Left
 * out rather than shipped with that caveat baked in silently.
 */
import type { ValidationReport } from '@ifc-lite/ids';
import { calculateSummary } from '@ifc-lite/ids';
import type { IdsReportBlock, IdsReportCheckSummary } from './types.js';

/** A frozen snapshot of `report`, as `types.ts`'s `IdsReportBlock` stores it. */
export function idsReportBlockFromReport(report: ValidationReport, id: string): IdsReportBlock {
  const summary = calculateSummary(report.specificationResults);
  const checks: IdsReportCheckSummary[] = report.specificationResults.map((result) => ({
    id: result.specification.id,
    shortDescription: result.specification.name,
    longDescription: result.specification.description,
    checked: result.applicableCount,
    passed: result.passedCount,
    failed: result.failedCount,
    passRate: result.passRate,
  }));
  const sourceName = report.source.kind === 'ids' ? report.source.document.info.title : report.source.ruleSet.name;
  return {
    kind: 'ids-report',
    id,
    sourceName,
    generatedAt: report.timestamp.toISOString(),
    summary: {
      checked: summary.totalEntitiesChecked,
      passed: summary.totalEntitiesPassed,
      failed: summary.totalEntitiesFailed,
      passRate: summary.overallPassRate,
    },
    checks,
  };
}
