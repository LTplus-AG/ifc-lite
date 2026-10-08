/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Chart review: the exact path a dashboard card takes. The `elements` dataset
 * is built for the proposal's scope and fields (`buildElementsDataset`), its
 * source filter resolved by the shared evaluator (`resolveChartFilter`) and
 * applied (`applyChartFilter`), and the result aggregated by Charts
 * `aggregate`. The aggregation's own `total`, `unbucketed` and `unmeasured`
 * become the denominators: rows without a dimension value are `unassigned`,
 * and a sum states how many of the charted rows carried the measure.
 */

import { aggregate, elementFieldLabel, type ElementFieldBinding } from '@ifc-lite/charts';
import type { ViewerState } from '@/store';
import { buildElementsDataset, chartScopeKey } from '@/lib/charts/datasets/elements';
import type { ElementFieldCatalog } from '@/lib/charts/element-field-reader';
import { applyChartFilter, resolveChartFilter } from '@/lib/charts/source-filter';
import { toGlobalIdFromModels } from '@/store/globalId';
import { definedModelTagIdsOf, evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { fieldIdentityKey, resolveChartSpec, type ChartProposal, type FieldIdentity } from './chart-proposal';
import { modelSchemaIndex } from './model-schema';
import { analysisChartDataset, analysisChartInputs, isAnalysisChartSource, validateAnalysisColumns } from './analysis-chart';
import { populationOf, revisionOf, type ArtifactPreview, type MeasureSummary } from './preview-shared';

/** The binding the chart editor's field picker would offer for `field`, from what the loaded models carry. */
export function discoveredBinding(field: FieldIdentity, catalog: ElementFieldCatalog): ElementFieldBinding | null {
  const key = fieldIdentityKey(field);
  const options = [...catalog.attributes, ...[...catalog.properties.values()].flat(), ...[...catalog.quantities.values()].flat(), ...catalog.relations];
  return options.find((option) => fieldIdentityKey(option.binding) === key)?.binding ?? null;
}

export async function previewChart(proposal: ChartProposal, state: ViewerState, signal?: AbortSignal): Promise<ArtifactPreview> {
  signal?.throwIfAborted();
  if (isAnalysisChartSource(proposal.chart.source)) return previewAnalysisChart(proposal, state);
  const { catalog } = await modelSchemaIndex(state, signal);
  const spec = resolveChartSpec(proposal.chart, `chart-${crypto.randomUUID()}`, (field) => discoveredBinding(field, catalog));
  const fields = [spec.elementField, spec.measureField].filter((field): field is ElementFieldBinding => !!field);
  const scopeKey = chartScopeKey(proposal.scope, state);
  let dataset = buildElementsDataset(proposal.scope, fields, state);
  const ids = await resolveChartFilter(evaluatorModelsFromState(state), spec.filter,
    (modelId, expressId) => toGlobalIdFromModels(state.models, modelId, expressId),
    { definedModelTagIds: definedModelTagIdsOf(state), limit: Number.POSITIVE_INFINITY, signal });
  if (ids) dataset = applyChartFilter(dataset, ids);
  const aggregation = aggregate(spec, dataset);
  const rows = dataset.rows.length;
  // A row with no dimension value is reported once, as `unassigned`; the sum's denominator is the charted rows.
  const charted = rows - aggregation.unbucketed;
  const measures: MeasureSummary[] = spec.measure.agg === 'sum' && spec.measureField
    ? [{ label: elementFieldLabel(spec.measureField), unit: aggregation.unit ?? null, total: aggregation.total,
      measured: charted - (aggregation.unmeasured ?? 0), rows: charted }]
    : [];
  const refs = dataset.rows.flatMap((row) => {
    const ref = row.ids.length > 0 ? state.resolveGlobalIdFromModels(row.ids[0]) : null;
    return ref ? [{ modelId: ref.modelId }] : [];
  });
  return {
    kind: 'chart.proposal', matched: rows, population: populationOf(refs, state), sampleColumns: [], samples: [], measures,
    buckets: aggregation.categories.map((bucket) => ({ label: bucket.label, count: bucket.count, value: bucket.value, color: bucket.color })),
    unassigned: aggregation.unbucketed, ...(aggregation.unit ? { unit: aggregation.unit } : {}),
    artifact: { kind: 'chart.proposal', spec, scope: proposal.scope }, revision: revisionOf(state, scopeKey),
  };
}

/** Native analysis rows are findings/topics/tasks/results/changes, not one element each. */
function previewAnalysisChart(proposal: ChartProposal, state: ViewerState): ArtifactPreview {
  const source = proposal.chart.source;
  if (!isAnalysisChartSource(source)) throw new Error('Unknown analysis source');
  const spec = resolveChartSpec(proposal.chart, `chart-${crypto.randomUUID()}`, () => null);
  const dataset = analysisChartDataset(source, state);
  validateAnalysisColumns(spec, dataset);
  const aggregation = aggregate(spec, dataset);
  const charted = dataset.rows.length - aggregation.unbucketed;
  const measure = spec.measure.agg === 'sum' ? dataset.columns.find(column => column.id === spec.measure.column) : undefined;
  const modelFor = new Map<number, string | null>();
  let unresolved = 0;
  const modelRows = dataset.rows.flatMap(row => {
    const models = new Set<string>();
    for (let i = 0; i < row.ids.length; i++) {
      const id = row.ids[i];
      let modelId = modelFor.get(id);
      if (modelId === undefined) {
        modelId = state.resolveGlobalIdFromModels(id)?.modelId ?? null;
        modelFor.set(id, modelId);
      }
      if (modelId !== null) models.add(modelId);
    }
    if (models.size === 0) unresolved++;
    return [...models].map(modelId => ({ modelId }));
  });
  return {
    kind: 'chart.proposal', rowSource: source, unlinkedRows: unresolved, matched: dataset.rows.length,
    population: populationOf(modelRows, state), sampleColumns: [], samples: [],
    measures: measure ? [{ label: measure.label, unit: aggregation.unit ?? null, total: aggregation.total,
      measured: charted - (aggregation.unmeasured ?? 0), rows: charted }] : [],
    buckets: aggregation.categories.map(bucket => ({ label: bucket.label, count: bucket.count, value: bucket.value, color: bucket.color })),
    unassigned: aggregation.unbucketed, ...(aggregation.unit ? { unit: aggregation.unit } : {}),
    artifact: { kind: 'chart.proposal', spec, scope: proposal.scope },
    revision: { ...revisionOf(state, chartScopeKey(proposal.scope, state)), analysis: { source, inputs: analysisChartInputs(source, state), fingerprint: dataset.fingerprint } },
  };
}
