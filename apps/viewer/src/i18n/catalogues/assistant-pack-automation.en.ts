/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** Assistant evidence adapters in `lib/assistant/adapters/pack-automation.ts` (#6833). */
export const assistantPackAutomationEn = {
  'assistantSources.flowRun.title': 'Flow run',
  'assistantSources.flowRun.description': 'The last run of the open graph: node results, warnings, outputs and artifacts.',
  'assistantSources.flowRun.rows': 'Rows are node results, run warnings, artifacts (metadata only), graph outputs and log entries.',
  'assistantSources.flowRun.unavailable': 'No Flow run result was available at capture. Run the graph in Flow and refresh the evidence.',
  'assistantSources.flowRun.discussRun': 'Discuss run with AI',
  'assistantSources.flowRun.suggestExplain': 'Explain what this run did and what it produced',
  'assistantSources.flowRun.suggestFix': 'Why did nodes fail or warn, and how can I fix them?',
  'assistantSources.flowRun.statusRunning': 'Running…',
  'assistantSources.flowRun.statusOk': { one: 'Succeeded · {count} node', other: 'Succeeded · {count} nodes' },
  'assistantSources.flowRun.statusFailed': { one: 'Failed · {count} node', other: 'Failed · {count} nodes' },
  'assistantSources.flowRun.statusError': 'Run failed before producing a result',
  'assistantSources.flowRun.statusNone': 'No run yet',
  'assistantSources.script.description': 'The last script run: returned value, diagnostics and console output.',
  'assistantSources.script.rows': 'Rows are the returned value, diagnostics and log entries. The script source is excluded.',
  'assistantSources.script.unavailable': 'No script run was available at capture. Run a script in the Script Editor and refresh the evidence.',
  'assistantSources.script.suggestExplain': 'Explain what this script run returned and logged',
  'assistantSources.script.suggestFix': 'Why did this script fail, and how can I fix it?',
  'assistantSources.script.statusRunning': 'Running…',
  'assistantSources.script.statusError': 'Last run failed',
  'assistantSources.script.statusResult': { one: 'Last run · {count} log entry', other: 'Last run · {count} log entries' },
  'assistantSources.script.statusDiagnostics': { one: '{count} diagnostic', other: '{count} diagnostics' },
  'assistantSources.script.statusNone': 'No run yet',
  'assistantSources.document.description': 'The open document’s blocks, bindings and page settings.',
  'assistantSources.document.rows': 'Rows are document blocks in order. Text is the unresolved template; images and charts are metadata only.',
  'assistantSources.document.unavailable': 'No document was open at capture. Open a document and refresh the evidence.',
  'assistantSources.document.suggestReview': 'Review the structure of this document and suggest improvements',
  'assistantSources.document.suggestBindings': 'Which model fields does this document reference?',
  'assistantSources.document.status': { one: '{name} · {count} block', other: '{name} · {count} blocks' },
  'assistantSources.document.statusNone': 'No open document',
} as const satisfies Record<string, TranslationValue>;
