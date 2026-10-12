/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { buildCards, type CoordinationCard, type ReviewTotals } from './cards.js';
import type { FindingRun, FindingSource, FindingSourceKind, ReviewFinding, ReviewModel, ReviewMessage } from './types.js';

export interface ReviewSnapshot<Message extends ReviewMessage = ReviewMessage> {
  runs: FindingRun<Message>[];
  findings: ReviewFinding<Message>[];
  cards: CoordinationCard<Message>[];
  totals: ReviewTotals;
  /** Failed source contributions remain explicit rather than a clean empty result. */
  failed: Array<{ source: FindingSourceKind; message: string }>;
}

export function snapshotFrom<Message extends ReviewMessage>(sources: readonly FindingSource<Message>[], models: readonly ReviewModel[], onFailure?: (source: FindingSourceKind, error: unknown) => void): ReviewSnapshot<Message> {
  const runs: FindingRun<Message>[] = [];
  const findings: ReviewFinding<Message>[] = [];
  const failed: ReviewSnapshot<Message>['failed'] = [];
  for (const source of sources) {
    try {
      const result = source.collect(models);
      for (const run of result.runs) runs.push(run);
      for (const finding of result.findings) findings.push(finding);
    } catch (error) {
      onFailure?.(source.kind, error);
      failed.push({ source: source.kind, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const { cards, totals } = buildCards(findings, models);
  return { runs, findings, cards, totals, failed };
}
