/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Analysis charts use the native dataset columns, never invented IFC bindings (#7106). */
import { validateChartSpec, type ChartDataset, type ChartSource, type ChartSpec } from '@ifc-lite/charts';
import { CLASH_DATASET_COLUMNS } from '@/lib/charts/datasets/clash';
import { BCF_DATASET_COLUMNS } from '@/lib/charts/datasets/bcf';
import { SCHEDULE_DATASET_COLUMNS } from '@/lib/charts/datasets/schedule';
import { IDS_DATASET_COLUMNS } from '@/lib/charts/datasets/ids';
import { COMPARE_DATASET_COLUMNS } from '@/lib/charts/datasets/compare';
import { analysisStampOf, isAnalysisStale } from '@/hooks/useAnalysisStaleness';
import type { ViewerState } from '@/store';
import { chartDatasetFromState } from '@/lib/charts/datasets/from-state';
import { onlyKeys, record, requiredText } from './artifact-json';
import type { ChartDraft } from './chart-proposal';

export type AnalysisChartSource = Exclude<ChartSource, 'elements'>;
export const ANALYSIS_COLUMN_GUIDANCE = ([['clash', CLASH_DATASET_COLUMNS], ['bcf', BCF_DATASET_COLUMNS],
  ['schedule', SCHEDULE_DATASET_COLUMNS], ['ids', IDS_DATASET_COLUMNS], ['compare', COMPARE_DATASET_COLUMNS]] as const)
  .map(([source, columns]) => `${source}: ${columns.map(column => `${column.id} (${column.kind}${column.unit ? `, ${column.unit}` : ''})`).join(', ')}`).join('; ');

const SOURCES: readonly string[] = ['clash', 'bcf', 'schedule', 'ids', 'compare'];
export function isAnalysisChartSource(source: unknown): source is AnalysisChartSource {
  return typeof source === 'string' && SOURCES.includes(source);
}

function integer(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) throw new Error(`The chart ${name} must be an integer from 1 to 100`);
  return value;
}

export function parseAnalysisChart(chart: Record<string, unknown>, title: string): ChartDraft {
  if (!isAnalysisChartSource(chart.source)) throw new Error('Unknown native analysis chart source');
  if (chart.elementField !== undefined || chart.measureField !== undefined) throw new Error('Analysis charts name dataset columns, not IFC element fields');
  if (chart.filter !== undefined) throw new Error('Analysis chart proposals do not yet support element filters');
  if (!record(chart.measure) || (chart.measure.agg !== 'count' && chart.measure.agg !== 'sum')) throw new Error('The chart measure must count or sum');
  onlyKeys(chart.measure, ['agg', 'column'], 'The chart measure');
  if (chart.measure.agg === 'count' && chart.measure.column !== undefined) throw new Error('A counted chart has no summed column');
  const column = chart.measure.agg === 'sum' ? requiredText(chart.measure.column, 'The summed dataset column') : undefined;
  if (chart.sort !== undefined && chart.sort !== 'value' && chart.sort !== 'label') throw new Error('The chart sort must be value or label');
  const type = requiredText(chart.type, 'The chart type') as ChartDraft['type'];
  const draft: ChartDraft = { title: chart.title === undefined ? title : requiredText(chart.title, 'The chart title'), source: chart.source, type,
    measure: { agg: chart.measure.agg, ...(column ? { column } : {}) },
    ...(chart.dimension !== undefined ? { dimension: requiredText(chart.dimension, 'The dataset dimension') } : {}),
    ...(chart.stackBy !== undefined ? { stackBy: requiredText(chart.stackBy, 'The stacked dataset dimension') } : {}),
    ...(chart.sort !== undefined ? { sort: chart.sort } : {}),
    ...(chart.topN !== undefined ? { topN: integer(chart.topN, 'topN') } : {}),
    ...(chart.bins !== undefined ? { bins: integer(chart.bins, 'bins') } : {}) };
  resolveAnalysisChartSpec(draft, 'proposal');
  return draft;
}

export function resolveAnalysisChartSpec(draft: ChartDraft, id: string): ChartSpec {
  if (!isAnalysisChartSource(draft.source)) throw new Error('Unknown analysis source');
  const spec = { id, title: draft.title, source: draft.source, type: draft.type, measure: draft.measure,
    ...(draft.dimension !== undefined ? { dimension: draft.dimension } : {}),
    ...(draft.stackBy !== undefined ? { stackBy: draft.stackBy } : {}),
    ...(draft.sort !== undefined ? { sort: draft.sort } : {}),
    ...(draft.topN !== undefined ? { topN: draft.topN } : {}),
    ...(draft.bins !== undefined ? { bins: draft.bins } : {}) } as ChartSpec;
  const errors = validateChartSpec(spec);
  if (errors.length) throw new Error(`The chart does not validate: ${errors.map(error => `${error.path} ${error.message}`).join('; ')}`);
  return spec;
}

/** Immutable native inputs watched by review, including changes which do not start a new run. */
export function analysisChartInputs(source: AnalysisChartSource, state: ViewerState): readonly unknown[] {
  switch (source) {
    case 'clash': return [state.clashResult, state.clashRawResult, state.clashRunSeq, state.clashReviews, state.clashGroups, state.clashRunning, state.geometryContentVersion, state.modelPlacement];
    case 'bcf': return [state.bcfProject, state.ifcDataStore];
    case 'schedule': return [state.scheduleData, state.scheduleSourceModelId, state.activeModelId, state.animationEnabled, state.playbackTime];
    case 'ids': return [state.idsValidationReport, state.activeModelId, state.geometryContentVersion, state.modelPlacement];
    case 'compare': return [state.compareResult, state.compareRunSeq, state.geometryContentVersion, state.modelPlacement];
  }
}

export function analysisChartDataset(source: AnalysisChartSource, state: ViewerState): ChartDataset {
  const available = source === 'clash' ? !!state.clashResult && !state.clashRunning : source === 'bcf' ? !!state.bcfProject
    : source === 'schedule' ? !!state.scheduleData : source === 'ids' ? !!state.idsValidationReport : !!state.compareResult;
  if (!available) throw new Error(`The native ${source} chart source is unavailable`);
  const report = source === 'clash' ? state.clashRawResult ?? state.clashResult : source === 'ids' ? state.idsValidationReport : source === 'compare' ? state.compareResult : null;
  if (isAnalysisStale(analysisStampOf(report), state)) throw new Error(`The native ${source} analysis is out of date; rerun it before reviewing a chart`);
  return chartDatasetFromState(source, state, { kind: 'all' }, []);
}

export function validateAnalysisColumns(spec: ChartSpec, dataset: ChartDataset): void {
  const column = (id: string | undefined, purpose: string) => {
    const found = dataset.columns.find(item => item.id === id);
    if (!found) throw new Error(`The ${dataset.source} dataset has no ${purpose} column ${String(id)}`);
    return found;
  };
  if (spec.type !== 'elementCount') {
    const dimension = column(spec.dimension, 'dimension');
    if (spec.type === 'histogram' && dimension.kind !== 'number') throw new Error('A histogram needs a numeric dataset dimension');
    if (spec.type === 'timeline' && dimension.kind !== 'date') throw new Error('A timeline needs a date dataset dimension');
  }
  if (spec.type === 'stackedBar') column(spec.stackBy, 'stacked dimension');
  if (spec.measure.agg === 'sum' && column(spec.measure.column, 'measure').kind !== 'number') throw new Error('A summed dataset column must be numeric');
}
