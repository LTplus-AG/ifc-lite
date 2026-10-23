/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { reportBlockSourceKind, validateIdsReportBlock } from '@ifc-lite/sdk/review';
export type { IdsReportCheckSummary, IdsReportRuleSummary, IdsReportCardinality, IdsReportVariant, IdsReportBlock } from '@ifc-lite/sdk/review';

import { isUnmatchedSpecification } from '../validation/report-summary.js';
import { reportBlockSourceKind, type IdsReportBlock } from '@ifc-lite/sdk/review';

/** Unmatched IDS specifications keep their own units beside the entity benchmark (#8065). */
export function notCheckedIdsSpecifications(block: Pick<IdsReportBlock, 'sourceKind' | 'checks'>): number {
  return reportBlockSourceKind(block) === 'ids' ? block.checks.filter((check) => isUnmatchedSpecification(check.checked, check.error)).length : 0;
}
