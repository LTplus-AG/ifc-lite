/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** Assistant evidence adapters in `lib/assistant/adapters/pack-coordination.ts` (#6833). */
export const assistantPackCoordinationEn = {
  'assistantSources.changes.description': 'Edits in this session’s undo history, per operation and model.',
  'assistantSources.changes.rows': 'Rows represent individual edits of the active operations, newest operation first.',
  'assistantSources.changes.unavailable': 'No model is loaded, so there is no edit history to attach.',
  'assistantSources.changes.ready': { one: '{count} edit', other: '{count} edits' },
  'assistantSources.changes.none': 'No edits yet',
  'assistantSources.changes.suggestSummary': 'Summarize what was edited and in which models',
  'assistantSources.changes.suggestReview': 'Which edits should I review before exporting?',
  'assistantSources.changeSets.description': 'Named groups of edits: their sizes, models and kinds of edit.',
  'assistantSources.changeSets.rows': 'Rows represent change sets (metadata only, no edit values or file contents).',
  'assistantSources.changeSets.unavailable': 'No change set exists. Create one in the Change sets panel.',
  'assistantSources.changeSets.ready': { one: '{count} change set', other: '{count} change sets' },
  'assistantSources.changeSets.none': 'No change sets',
  'assistantSources.changeSets.suggestSummary': 'Summarize what each change set contains',
  'assistantSources.schedule.description': 'Tasks of the 4D schedule with dates, milestones and assigned products.',
  'assistantSources.schedule.rows': 'Rows represent schedule tasks. Missing dates are null, not guessed.',
  'assistantSources.schedule.unavailable': 'No schedule is loaded. Open the Schedule panel to read IfcTask data, or generate or import a schedule.',
  'assistantSources.schedule.ready': { one: '{count} task', other: '{count} tasks' },
  'assistantSources.schedule.none': 'No schedule',
  'assistantSources.schedule.suggestSummary': 'Summarize the schedule: phases, milestones and overall duration',
  'assistantSources.schedule.suggestGaps': 'Which tasks have no dates or no assigned products?',
  'assistantSources.semantic.description': 'Linked records, how they resolve to model elements, and validation findings.',
  'assistantSources.semantic.rows': 'Rows represent linked records with their resolution, then validation findings.',
  'assistantSources.semantic.unavailable': 'No linked records are loaded. Load records in the Linked records panel.',
  'assistantSources.semantic.ready': { one: '{count} record · {findings} findings', other: '{count} records · {findings} findings' },
  'assistantSources.semantic.none': 'No records loaded',
  'assistantSources.semantic.suggestUnresolved': 'Which records do not resolve to a model element, and why?',
  'assistantSources.semantic.suggestFindings': 'Explain the validation findings',
} as const satisfies Record<string, TranslationValue>;
