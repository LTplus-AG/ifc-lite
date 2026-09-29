/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An IDS report block's content (#5125): a frozen snapshot of a
 * `ValidationReport`, taken from `useViewerStore().idsValidationReport`
 * when the block is added or refreshed. Reuses the report's own numbers —
 * `calculateSummary` for the top summary (it already floors the pass rate,
 * reads 100 rather than NaN on zero checked entities, and reports 0 instead
 * of 100 whenever a specification failed (#5212), see
 * `packages/ids/src/validation/validator.ts`), `SpecificationResult`'s own
 * `passRate` per check — so nothing here recomputes validation math.
 *
 * Rule descriptions come from the IDS source document when available.
 * Per-rule counts use entity results only when the report includes every
 * applicable entity; otherwise they are explicitly unavailable.
 */
import type { SpecificationResult, ValidationReport } from '@ifc-lite/ids';
import { boundedPassRate, calculateSummary, formatConstraint } from '@ifc-lite/ids';
import type { IDSConstraint, IDSFacet } from '@ifc-lite/ids';
import type { IdsReportBlock, IdsReportCheckSummary, IdsReportRuleSummary, IdsReportVariant } from './types.js';

/** A constraint as bare text: a simple value without `formatConstraint`'s quotes. */
const bare = (c: IDSConstraint): string => (c.type === 'simpleValue' ? c.value : formatConstraint(c));

/** The attribute / property / entity name a requirement facet is about, for the compact layout. */
function facetName(facet: IDSFacet): string | undefined {
  switch (facet.type) {
    case 'property': return bare(facet.baseName);
    case 'attribute': return bare(facet.name);
    case 'entity': return bare(facet.name);
    case 'classification': return facet.system ? bare(facet.system) : 'Classification';
    case 'material': return 'Material';
    case 'partOf': return facet.relation;
    default: return undefined;
  }
}

type RuleAccumulator = { name?: string; shortDescription: string; longDescription?: string; seen: number; passed: number; failed: number };

function rulesForCheck(report: ValidationReport, result: SpecificationResult): IdsReportRuleSummary[] {
  const sourceSpec = report.source.kind === 'ids'
    ? report.source.document.specifications.find((spec) => spec.id === result.specification.id)
    : undefined;
  const rules = new Map<string, RuleAccumulator>();
  for (const requirement of sourceSpec?.requirements ?? []) {
    rules.set(requirement.id, {
      name: facetName(requirement.facet),
      shortDescription: requirement.id,
      longDescription: requirement.description,
      seen: 0, passed: 0, failed: 0,
    });
  }
  for (const entity of result.entityResults) {
    for (const check of entity.requirementResults) {
      const id = check.requirement.id;
      const rule: RuleAccumulator = rules.get(id) ?? { shortDescription: id, seen: 0, passed: 0, failed: 0 };
      rule.shortDescription = check.requirement.label || id;
      if (!rule.longDescription) rule.longDescription = check.checkedDescription || undefined;
      rule.seen++;
      if (check.status === 'pass') rule.passed++;
      if (check.status === 'fail') rule.failed++;
      rules.set(id, rule);
    }
  }
  return [...rules].map(([id, rule]) => {
    const complete = result.entityResults.length === result.applicableCount && rule.seen === result.applicableCount;
    const measured = rule.passed + rule.failed;
    return {
      id,
      ...(rule.name ? { name: rule.name } : {}),
      shortDescription: rule.shortDescription,
      longDescription: rule.longDescription,
      checked: result.applicableCount,
      passed: complete ? rule.passed : null,
      failed: complete ? rule.failed : null,
      passRate: complete ? boundedPassRate(rule.passed, measured) : null,
    };
  });
}

/** A frozen snapshot of `report`, as `types.ts`'s `IdsReportBlock` stores it. */
export function idsReportBlockFromReport(report: ValidationReport, id: string, variant?: IdsReportVariant): IdsReportBlock {
  const summary = calculateSummary(report.specificationResults);
  const checks: IdsReportCheckSummary[] = report.specificationResults.map((result) => ({
    id: result.specification.id,
    shortDescription: result.specification.name,
    longDescription: result.specification.description,
    checked: result.applicableCount,
    passed: result.passedCount,
    failed: result.failedCount,
    passRate: result.passRate,
    rules: rulesForCheck(report, result),
  }));
  const sourceName = report.source.kind === 'ids' ? report.source.document.info.title : report.source.ruleSet.name;
  return {
    kind: 'ids-report',
    id,
    ...(variant ? { variant } : {}),
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
