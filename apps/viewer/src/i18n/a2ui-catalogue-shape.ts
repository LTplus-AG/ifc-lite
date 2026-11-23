/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Eager key and parameter metadata for the lazy A2UI catalogue
 * (`catalogues/a2ui.en.ts`), so contributed locales validate before the A2UI
 * chunk loads. Checked against the catalogue in `catalogue-problems.test.ts`.
 */

const A2UI_TAILS = new Set(('loading surfaceLabel noValue noGroupValue empty unloadedModel queryProblem truncated error.title error.fix table.caption table.sortBy table.previous table.next table.page table.group table.rowLabel list.itemLabel card.selectionEmpty card.notFound card.attributes card.properties card.quantities card.materials card.classifications card.spatial card.flyTo stat.unavailable chart.other chart.noNumbers chart.label chart.groups chart.selectGroup legend.apply legend.applied legend.reset legend.toggle action.select action.isolate action.hide action.show action.colorize action.flyTo action.resetView action.exportCsv action.count action.refused action.failed followUps').split(' '));
const A2UI_PARAMETERS: Record<string, readonly string[]> = {'unloadedModel': ['model'], 'queryProblem': ['message', 'path'], 'truncated': ['shown', 'total'], 'table.caption': ['shown', 'total'], 'table.sortBy': ['column'], 'table.page': ['page', 'pages'], 'table.group': ['count', 'group'], 'table.rowLabel': ['name'], 'list.itemLabel': ['name'], 'chart.label': ['title'], 'chart.noNumbers': ['path'], 'chart.selectGroup': ['group', 'value'], 'legend.toggle': ['value'], 'action.count': ['count'], 'action.refused': ['reason'], 'action.failed': ['reason']};

export function a2uiMessageParameters(key: string): readonly string[] | null {
  if (!key.startsWith('a2ui.')) return null;
  const tail = key.slice('a2ui.'.length);
  return A2UI_TAILS.has(tail) ? A2UI_PARAMETERS[tail] ?? [] : null;
}
