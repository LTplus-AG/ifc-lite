/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * AI report drafts and saved AI reports (#6918): narrative language, typed
 * claim review (`ReportDraftReview.tsx`, `ReportClaimList.tsx`) and evidence
 * refresh of a saved report (`AiReportRefresh.tsx`).
 */
export const aiReportsEn = {
  'aiReports.language': 'Narrative language',
  'aiReports.languageHint': 'The report text is requested in this language. The viewer language is unchanged.',
  'aiReports.draftWithAi': 'Draft report with AI',
  'aiReports.requestPrompt': 'Draft a report narrative of this evidence for coordination review, with typed report claims. {instruction}',
  'aiReports.languageMismatch': 'The answer declares its language as {declared}, not the chosen {chosen}. Draft again or choose that language.',
  'aiReports.claims': 'Claims checked against captured evidence',
  'aiReports.noClaims': 'This answer has no typed claims. Only its row citations were checked; verify every statement yourself.',
  'aiReports.statusSupported': 'Supported by data',
  'aiReports.statusUnverifiable': 'Unverifiable',
  'aiReports.statusContradicted': 'Contradicted',
  'aiReports.claimEdited': 'Edited by you',
  'aiReports.editClaim': 'Edit claim',
  'aiReports.claimText': 'Claim text',
  'aiReports.saveClaim': 'Use edited text',
  'aiReports.cancelEdit': 'Cancel',
  'aiReports.removeClaim': 'Remove claim',
  'aiReports.contradictedBlocks': { one: '{count} claim contradicts the captured evidence. Edit or remove it before saving.', other: '{count} claims contradict the captured evidence. Edit or remove them before saving.' },
  'aiReports.unknownCitation': '{citation}: not in the captured evidence',
  'aiReports.factLine': '{citation} {field}: claimed {claimed}',
  'aiReports.reportRecord': 'AI report · {language} · revision {revision} · evidence captured {capturedAt}',
  'aiReports.blockOrigins': 'Text blocks: {generated} AI-generated, {edited} edited by people.',
  'aiReports.refreshEvidence': 'Refresh evidence',
  'aiReports.refreshHint': 'Recaptures the native source, re-checks every claim and regenerates untouched AI text. Your edits are kept unless you choose otherwise below.',
  'aiReports.refreshClaim': '{id}: {before} → {after}; {changed} changed, {missing} missing',
  'aiReports.conflicts': 'Edited blocks the refresh would change',
  'aiReports.noConflicts': 'No edited block is affected.',
  'aiReports.replaceEdit': 'Replace my edit with the regenerated text',
  'aiReports.removeEdit': 'Remove this edited block; the refresh no longer generates it',
  'aiReports.yourText': 'Your text',
  'aiReports.regeneratedText': 'Regenerated text',
  'aiReports.applyRefresh': 'Apply refresh',
  'aiReports.cancelRefresh': 'Discard refresh',
  'aiReports.refreshApplied': 'Evidence refreshed. Changed and missing facts are flagged in the document.',
  'aiReports.originGenerated': 'AI-generated',
  'aiReports.originEdited': 'AI text edited',
  'aiReports.sourceUnsupported': 'This report source cannot be recaptured in this viewer.',
  'aiReports.noNativeResult': 'No native result is available for this source. Run it in its panel, then refresh evidence.',
  'aiReports.analysisStale': 'The native result is out of date: the model changed after it was run. Run it again in its panel, then refresh evidence.',
  'aiReports.documentChanged': 'The document changed while the refresh was open. Refresh evidence again.',
  'aiReports.modelsChanged': 'The loaded models differ from those this report was drafted against. Claims will be re-checked against the loaded models.',
} as const satisfies Record<string, TranslationValue>;
