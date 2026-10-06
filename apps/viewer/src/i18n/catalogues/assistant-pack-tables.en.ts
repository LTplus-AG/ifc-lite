/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** Assistant evidence adapters in `lib/assistant/adapters/pack-tables.ts` (#6833). */
export const assistantPackTablesEn = {
  'assistantSources.lists.description': 'The last list run: its columns, units, totals and rows.',
  'assistantSources.lists.rows': 'Rows represent elements matched by the executed list, with their column values.',
  'assistantSources.lists.unavailable': 'No list result was available at capture. Run a list in the Lists panel and refresh the evidence.',
  'assistantSources.lists.suggestSummary': 'Summarize this list and its totals',
  'assistantSources.lists.suggestGaps': 'Which rows are missing values?',
  'assistantSources.lists.running': 'Running…',
  'assistantSources.lists.ready': { one: '{count} row', other: '{count} rows' },
  'assistantSources.lists.notRun': 'No list run yet',

  'assistantSources.charts.title': 'Charts',
  'assistantSources.charts.description': 'The active dashboard: every chart’s buckets, values and what could not be placed.',
  'assistantSources.charts.rows': 'Rows represent chart buckets, each with its chart, value, count and unit.',
  'assistantSources.charts.unavailable': 'No chart dashboard was available at capture. Open the Charts panel and refresh the evidence.',
  'assistantSources.charts.suggestSummary': 'What stands out in these charts?',
  'assistantSources.charts.suggestGaps': 'Which elements could not be charted, and why?',
  'assistantSources.charts.ready': { one: '{count} chart', other: '{count} charts' },
  'assistantSources.charts.noDashboard': 'No dashboard yet',
  'assistantSources.charts.noCharts': 'Dashboard has no charts',

  'assistantSources.cost.description': 'Cost items of every loaded model, with evaluated amounts, currencies and diagnostics.',
  'assistantSources.cost.rows': 'Rows represent IfcCostItem entries with their evaluated amount, currency and diagnostics.',
  'assistantSources.cost.unavailable': 'No cost source was available at capture. Load an IFC model to read its cost data.',
  'assistantSources.cost.suggestSummary': 'Summarize the cost totals per currency',
  'assistantSources.cost.suggestGaps': 'Which cost items have no amount, and why?',
  'assistantSources.cost.ready': { one: '{count} model with a cost source', other: '{count} models with a cost source' },
  'assistantSources.cost.noSource': 'No IFC source to read cost from',
} as const satisfies Record<string, TranslationValue>;
