/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslatableMessage } from '@/i18n';
import type { FindingRun as SharedFindingRun, RunGap as SharedRunGap, ReviewFinding as SharedReviewFinding,
  FindingSourceResult as SharedFindingSourceResult, FindingSource as SharedFindingSource } from '@ifc-lite/sdk/review';
export { FINDING_SOURCE_KINDS, RUN_GAP_CODES } from '@ifc-lite/sdk/review';
export type { FindingSourceKind, RunGapCode, FindingElement, FindingEvidence, FindingLifecycle, ReviewModel } from '@ifc-lite/sdk/review';
export type FindingRun = SharedFindingRun<TranslatableMessage>;
export type RunGap = SharedRunGap<TranslatableMessage>;
export type ReviewFinding = SharedReviewFinding<TranslatableMessage>;
export type FindingSourceResult = SharedFindingSourceResult<TranslatableMessage>;
export type FindingSource = SharedFindingSource<TranslatableMessage>;
