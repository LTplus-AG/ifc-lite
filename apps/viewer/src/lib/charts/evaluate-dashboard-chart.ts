/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { aggregate, type DashboardSpec } from '@ifc-lite/charts';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { evaluatorModelsFromState, definedModelTagIdsOf } from '../model-tags/evaluator-models';
import { chartElementFields } from './chart-fields';
import { resolveChartFilter } from './source-filter';
import { chartCardDataset, chartCardSlice } from './card-aggregation';
import { chartSourceContext, resolveChartSource, isRecordedChart } from './chart-source';
import { chartDatasetFromState } from './datasets/from-state';

/** Panel-equivalent source resolution, filters, scope and cross-chart slice; no mounted card needed. */
export async function evaluateDashboardChart(dashboard: DashboardSpec, chartId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const spec = dashboard.charts.find(chart => chart.id === chartId);
  if (!spec) throw new Error('Unknown chart in the requested dashboard.');
  const state = useViewerStore.getState();
  const source = resolveChartSource(spec, chartDatasetFromState(spec.source, state, dashboard.scope, chartElementFields([spec])), chartSourceContext(state));
  if (source.status === 'missing') throw new Error('The chart references saved content that is no longer available.');
  const ids = await resolveChartFilter(evaluatorModelsFromState(state), spec.filter,
    (modelId, expressId) => toGlobalIdFromModels(state.models, modelId, expressId), {
      signal, definedModelTagIds: definedModelTagIdsOf(state),
      limit: [...state.models.values()].reduce((n, model) => n + (model.maxExpressId ?? 0) + 1, 0),
      schemaVersion: state.models.get(state.activeModelId ?? '')?.ifcDataStore?.schemaVersion,
    });
  signal?.throwIfAborted();
  const now = useViewerStore.getState();
  if (now.models !== state.models || now.mutationVersion !== state.mutationVersion
    || now.savedComparisons !== state.savedComparisons || now.savedClashReports !== state.savedClashReports
    || now.clashResult !== state.clashResult || now.scheduleData !== state.scheduleData
    || now.idsValidationReport !== state.idsValidationReport || now.bcfProject !== state.bcfProject
    || now.compareResult !== state.compareResult || now.savedLenses !== state.savedLenses
    || now.modelTags !== state.modelTags || now.modelTagAssignments !== state.modelTagAssignments) throw new Error('Chart source changed during evaluation.');
  if (now.chartSlice !== state.chartSlice || now.chartSliceSource !== state.chartSliceSource) {
    throw new Error('Chart selection changed during evaluation.');
  }
  const dataset = chartCardDataset(spec, source.dataset, { status: 'ok', ids: ids ?? new Set() });
  return aggregate(spec, dataset, { slice: chartCardSlice(spec, isRecordedChart(spec), state.chartSlice, state.chartSliceSource) });
}
