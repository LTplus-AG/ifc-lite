/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ListDefinition } from '@ifc-lite/lists';
import type { ProjectUnits } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import { runListFederated, type ModelProviderPair } from '../lists/run-list';
import { evaluatorModelsFromState } from '../model-tags/evaluator-models';
import { buildExportModel } from '../lists/export/model';
import { detectNumericColumns } from '@/components/viewer/lists/list-table-utils';
import type { TableState } from './resolve-table';

/** List execution and export projection shared by the subscribed and callable document paths. */
export async function prepareListTable(list: ListDefinition, pairs: readonly ModelProviderPair[],
  modelUnits: Map<string, ProjectUnits>, state: ViewerState,
  options: { signal?: AbortSignal; today?: Date } = {},
): Promise<TableState> {
  options.signal?.throwIfAborted();
  const result = await runListFederated(list, pairs, state, {
    evaluatorModels: evaluatorModelsFromState(state), signal: options.signal,
  });
  options.signal?.throwIfAborted();
  return { status: 'ok', model: buildExportModel({
    title: list.name, columns: result.columns, rows: result.rows, grouping: list.grouping,
    numericCols: detectNumericColumns(result.columns, result.rows), columnWidths: [],
    generatedAt: (options.today ?? new Date()).toLocaleString(), modelUnits,
    unitDisplayOverrides: state.unitDisplayOverrides,
  }) };
}
