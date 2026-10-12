/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Pure read-only coordination facts shared by native hosts and the viewer (#7372). */
export { FINDING_SOURCE_KINDS, RUN_GAP_CODES } from './review/types.js';
export type { FindingSourceKind, FindingRun, RunGapCode, RunGap, FindingElement, FindingEvidence,
  FindingLifecycle, ReviewFinding, FindingSourceResult, ReviewModel, FindingSource } from './review/types.js';
export { buildCards, totalsForCards } from './review/cards.js';
export type { CardElement, CardState, CoordinationCard, ReviewTotals } from './review/cards.js';
export { elementKey, resolveElement } from './review/identity.js';
export { validationFindings } from './review/validation.js';
export { bcfFindings } from './review/bcf.js';
export { typeDisciplines } from './review/disciplines.js';
export { snapshotFrom, type ReviewSnapshot } from './review/snapshot.js';

export { NativeReviewCaptures } from './review/native-captures.js';
export type { NativeReviewModel, ReviewCaptureToken } from './review/capture-types.js';
export { readNativeReview } from './review/native-snapshot.js';
