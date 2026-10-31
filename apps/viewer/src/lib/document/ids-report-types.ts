/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { reportBlockSourceKind, validateIdsReportBlock } from '@ifc-lite/sdk/review';
export type { IdsReportCheckSummary, IdsReportRuleSummary, IdsReportCardinality, IdsReportVariant, IdsReportBlock } from '@ifc-lite/sdk/review';

import { isUnmatchedSpecification } from '../validation/report-summary.js';
import { reportBlockSourceKind, type IdsReportBlock, type IdsReportCheckSummary } from '@ifc-lite/sdk/review';
import { boundedPassRate } from '@ifc-lite/ids';

/** Unmatched IDS specifications keep their own units beside the entity benchmark (#8065). */
export function notCheckedIdsSpecifications(block: Pick<IdsReportBlock, 'sourceKind' | 'checks'>): number {
  return block.checks.filter((check) => isUnmatchedIdsCheck(block, check)).length;
}

/** Requirement checks (entity × requirement) behind a rate, as the IDS panel counts them (#8065). */
export interface RequirementCheckRate { passed: number; total: number; rate: number }

/** A matched IDS specification has entities; an unmatched one is Not checked rather than 0% (#8204). */
export function isUnmatchedIdsCheck(block: Pick<IdsReportBlock, 'sourceKind'>, check: IdsReportCheckSummary): boolean {
  return reportBlockSourceKind(block) === 'ids' && isUnmatchedSpecification(check.checked, check.error);
}

/**
 * One IDS specification's requirement-check rate: the sum of its requirement
 * rows, so the specification row agrees with the panel card and with the rows
 * printed under it (#8204). Undefined when the snapshot cannot count every
 * check (a partial report, an error, or a rule-set check), which keeps the
 * engine's entity rate as the panel does.
 */
export function idsRequirementCheckRate(block: Pick<IdsReportBlock, 'sourceKind'>, check: IdsReportCheckSummary): RequirementCheckRate | undefined {
  if (reportBlockSourceKind(block) !== 'ids' || check.error !== undefined || check.checked === 0) return undefined;
  let passed = 0;
  let failed = 0;
  for (const rule of check.rules) {
    if (rule.passed === null || rule.failed === null) return undefined;
    passed += rule.passed;
    failed += rule.failed;
  }
  const total = passed + failed;
  return total > 0 ? { passed, total, rate: boundedPassRate(passed, total) } : undefined;
}

/** The whole IDS block's requirement checks, only when every matched specification can be counted, like the panel summary. */
export function idsBlockRequirementCheckRate(block: Pick<IdsReportBlock, 'sourceKind' | 'checks'>): RequirementCheckRate | undefined {
  if (reportBlockSourceKind(block) !== 'ids') return undefined;
  let passed = 0;
  let total = 0;
  for (const check of block.checks) {
    if (isUnmatchedIdsCheck(block, check)) continue;
    const rate = idsRequirementCheckRate(block, check);
    if (!rate) return undefined;
    passed += rate.passed;
    total += rate.total;
  }
  return total > 0 ? { passed, total, rate: boundedPassRate(passed, total) } : undefined;
}

/** The requirement checks worth a second ring: identical totals, as when every specification has one requirement, add nothing (#8417). */
export function idsRequirementRing(block: Pick<IdsReportBlock, 'sourceKind' | 'checks' | 'summary'>): RequirementCheckRate | undefined {
  const rate = idsBlockRequirementCheckRate(block);
  return rate && (rate.passed !== block.summary.passed || rate.total !== block.summary.checked) ? rate : undefined;
}

/** An IDS block lists specifications; only a rule set's entries are checks (#8204). */
export function reportItemsCountKey(block: Pick<IdsReportBlock, 'sourceKind'>): 'idsPanel.specifications' | 'document.preview.idsReportChecksCount' {
  return reportBlockSourceKind(block) === 'ids' ? 'idsPanel.specifications' : 'document.preview.idsReportChecksCount';
}

/** What a specification row's bar shows, shared by the preview and the PDF so they cannot drift (#8204). */
export type IdsCheckBar = { passed: number; checked: number; rate: number };

/** The bar for one check: requirement checks when known, else the engine's entity rate; none for an error or an unmatched IDS specification. */
export function idsCheckBar(block: Pick<IdsReportBlock, 'sourceKind'>, check: IdsReportCheckSummary): IdsCheckBar | undefined {
  if (check.error !== undefined || isUnmatchedIdsCheck(block, check)) return undefined;
  const checks = idsRequirementCheckRate(block, check);
  return checks ? { passed: checks.passed, checked: checks.total, rate: checks.rate } : { passed: check.passed, checked: check.checked, rate: check.passRate };
}
