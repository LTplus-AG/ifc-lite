/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * AI report drafts (#6918): narrative language and typed
 * claim review (`ReportDraftReview.tsx`, `ReportClaimList.tsx`).
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
} as const satisfies Record<string, TranslationValue>;
