/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** Assistant evidence adapters in `lib/assistant/adapters/pack-checks.ts` (#6833). */
export const assistantPackChecksEn = {
  'assistantSources.duplicates.title': 'Duplicate elements',
  'assistantSources.duplicates.description': 'Sets of coincident or overlapping copies found by the duplicate scan.',
  'assistantSources.duplicates.rows': 'Each row is one set of coincident elements, not one pair.',
  'assistantSources.duplicates.unavailable': 'No duplicate scan result was available at capture. Run Find duplicates in Clash detection and refresh the evidence.',
  'assistantSources.duplicates.suggestSummary': 'Summarize the duplicate sets and which element types they involve',
  'assistantSources.duplicates.suggestCleanup': 'Which duplicate sets look like exact copies worth removing first?',
  'assistantSources.duplicates.pickSets': { one: '{count} duplicate set', other: '{count} duplicate sets' },
  'assistantSources.manualChecklist.title': 'Manual checklist',
  'assistantSources.manualChecklist.description': 'The open manual checklist and the verdicts reviewers recorded for each loaded model.',
  'assistantSources.manualChecklist.rows': 'Each row is one checklist item on one model, with the reviewer’s verdict or none yet.',
  'assistantSources.manualChecklist.unavailable': 'No manual checklist was open at capture. Open or create one in Data validation and refresh the evidence.',
  'assistantSources.manualChecklist.suggestSummary': 'Summarize the checklist progress and the failed items',
  'assistantSources.manualChecklist.suggestOpen': 'Which items are still unanswered, and what should be checked next?',
  'assistantSources.manualChecklist.pickItems': { one: '{count} item', other: '{count} items' },
  'assistantSources.manualChecklist.pickNone': 'No checklist open',
  'assistantSources.lens.description': 'How many elements each rule of the active Lens matches, with examples.',
  'assistantSources.lens.rows': 'Each row is one Lens rule or colour-by value with its native match count.',
  'assistantSources.lens.unavailable': 'No evaluated Lens was active at capture. Activate a Lens and refresh the evidence.',
  'assistantSources.lens.suggestSummary': 'Explain what the active Lens shows and which rules match the most elements',
  'assistantSources.lens.pickRules': { one: '{name} · {count} rule', other: '{name} · {count} rules' },
  'assistantSources.lens.pickNone': 'No Lens active',
  'assistantSources.lens.pickPending': 'Evaluating…',
  'assistantSources.bcf.description': 'Topics of the loaded BCF project: status, priority, assignment and referenced elements.',
  'assistantSources.bcf.rows': 'Each row is one BCF topic. Comment text and snapshots are not included.',
  'assistantSources.bcf.unavailable': 'No BCF project was loaded at capture. Open or create BCF topics and refresh the evidence.',
  'assistantSources.bcf.suggestSummary': 'Summarize the open topics by status and priority',
  'assistantSources.bcf.suggestPriorities': 'Which topics should be resolved first, and who are they assigned to?',
  'assistantSources.bcf.pickTopics': { one: '{count} topic', other: '{count} topics' },
  'assistantSources.bcf.pickNone': 'No BCF project',
} as const satisfies Record<string, TranslationValue>;
