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

// Shared portable wire contract consumed by viewer save/import and native Review (#7372).
export { decodeSavedAnalysisRun } from './review/portable-analysis.js';
export type { SavedAnalysisRun, SavedClashRef, SavedDistance, SavedRunClash, SavedRunModel, SavedRunValidationReport } from './review/portable-analysis.js';

export { SAVED_VALIDATION_LIMITS, isSavedValidationElement, validateSavedValidationElements } from './review/portable-validation-evidence.js';
export type { SavedValidationElement, SavedValidationDefinition, SavedValidationElements } from './review/portable-validation-evidence.js';

export { bindSavedAnalysisModels } from './review/portable-analysis-binding.js';
export type { BindRefusalCode, BindRefusal } from './review/portable-analysis-binding.js';

export * from './review/portable-automation-provenance.js';
export * from './review/portable-report-metadata.js';
export { reportBlockSourceKind, validateIdsReportBlock } from './review/portable-ids-report.js';
export type { IdsReportCheckSummary, IdsReportRuleSummary, IdsReportCardinality, IdsReportVariant, IdsReportBlock } from './review/portable-ids-report.js';
export { validateManualReportBlock } from './review/portable-manual-report.js';
export type { ManualReportVerdict, ManualReportCounts, ManualReportItem, ManualReportBlock } from './review/portable-manual-report.js';
export * from './review/portable-saved-validation.js';

export { clashFindings, clashGlobalId } from './review/clash.js';
export { clashDisciplineCandidates, clashOccurrenceKey } from './review/clash-identity.js';
export { createNativeReviewIdentityTable } from './review/native-identity-table.js';
export { savedValidationFacts } from './review/saved-validation.js';

export { readPortableReview } from './review/portable-snapshot.js';
