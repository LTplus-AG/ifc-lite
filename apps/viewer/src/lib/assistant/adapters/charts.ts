/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChartDataset, ChartSource, DashboardSpec } from '@ifc-lite/charts';
import type { ViewerState } from '@/store';
import { chartElementFields } from '@/lib/charts/chart-fields';
import { chartDatasetFromState } from '@/lib/charts/datasets/from-state';
import { chartSourceContext, isRecordedChart, resolveChartSource } from '@/lib/charts/chart-source';
import { chartCardAggregation, chartCardDataset, chartCardSlice, chartClashRule, chartFilterSelector } from '@/lib/charts/card-aggregation';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

/** The dashboard the Charts panel shows: the active one, else the first (`ensureActiveDashboard`). */
function dashboardOf(s: ViewerState): DashboardSpec | null {
  return s.dashboards.find(d => d.id === s.activeDashboardId) ?? s.dashboards[0] ?? null;
}

/** Store fields each chart source's dataset is built from (`useChartDatasets`). */
function sourceInputs(s: ViewerState, source: ChartSource, scope: DashboardSpec['scope']): unknown[] {
  switch (source) {
    case 'elements': return [s.models, s.activeModelId, s.pinboardEntities, s.mutationViews, s.unitDisplayOverrides,
      ...(scope.kind === 'visible' ? [s.hiddenEntities, s.isolatedEntities, s.classFilter, s.lensHiddenIds, s.selectedStoreys, s.typeVisibility, s.chartVisibilityOwned] : [])];
    case 'clash': return [s.clashResult, s.clashReviews, s.clashGroups, s.clashRunSeq, s.models, s.savedClashReports, s.mutationVersion];
    case 'bcf': return [s.bcfProject, s.models];
    case 'schedule': return [s.scheduleData, s.scheduleSourceModelId, s.playbackTime, s.animationEnabled, s.models];
    case 'ids': return [s.idsValidationReport, s.models, s.activeModelId];
    case 'compare': return [s.compareResult, s.compareRunSeq, s.savedComparisons];
  }
}

const ready = (s: ViewerState, dashboard: DashboardSpec | null): boolean =>
  !!dashboard && dashboard.charts.length > 0 && (s.models.size > 0 || dashboard.charts.some(isRecordedChart));

type ChartStatus = 'aggregated' | 'filter-unresolved' | 'cannot-aggregate' | 'comparison-missing' | 'clash-report-missing';

/** Every chart of the active dashboard, aggregated by the card's own pure functions (`card-aggregation`). */
export const chartsAdapter: EvidenceAdapter = {
  id: 'charts', group: 'quantities', panelIds: ['charts'],
  titleKey: 'assistantSources.charts.title', descriptionKey: 'assistantSources.charts.description',
  rowMeaningKey: 'assistantSources.charts.rows', unavailableKey: 'assistantSources.charts.unavailable',
  suggestionKeys: ['assistantSources.charts.suggestSummary', 'assistantSources.charts.suggestGaps'],
  readiness: s => {
    const dashboard = dashboardOf(s);
    if (!dashboard) return { status: { labelKey: 'assistantSources.charts.noDashboard' }, ready: false };
    if (dashboard.charts.length === 0) return { status: { labelKey: 'assistantSources.charts.noCharts' }, ready: false };
    if (!ready(s, dashboard)) return { status: { labelKey: 'assistant.pickNoModels' }, ready: false };
    return { status: { labelKey: 'assistantSources.charts.ready', params: { count: dashboard.charts.length } }, ready: true };
  },
  identity: s => {
    const dashboard = dashboardOf(s);
    if (!dashboard) return null;
    const sources = new Set(dashboard.charts.map(chart => chart.source));
    return [dashboard, s.chartSlice, s.chartSliceSource, ...[...sources].sort().flatMap(source => sourceInputs(s, source, dashboard.scope))];
  },
  capture: (s, limit) => {
    const dashboard = dashboardOf(s);
    if (!dashboard || !ready(s, dashboard)) return unavailableCapture();
    const fields = chartElementFields(dashboard.charts);
    const datasets = new Map<ChartSource, ChartDataset>();
    const datasetFor = (source: ChartSource) => {
      const known = datasets.get(source);
      if (known) return known;
      const built = chartDatasetFromState(source, s, dashboard.scope, fields);
      datasets.set(source, built);
      return built;
    };
    const charts: unknown[] = [];
    const rows: unknown[] = [];
    let totalRows = 0;
    for (const chart of dashboard.charts) {
      const recorded = isRecordedChart(chart);
      const source = resolveChartSource(chart, datasetFor(chart.source), chartSourceContext(s));
      const filterSelector = chartFilterSelector(chart);
      // Element filters resolve asynchronously in the panel; an unresolved filter is never shown as the unfiltered rows.
      const outcome: ChartStatus = source.status === 'missing' ? (source.saved === 'clashReport' ? 'clash-report-missing' : 'comparison-missing')
        : filterSelector ? 'filter-unresolved' : 'aggregated';
      const aggregation = outcome === 'aggregated'
        ? chartCardAggregation(chart, chartCardDataset(chart, source.dataset, undefined), chartCardSlice(chart, recorded, s.chartSlice, s.chartSliceSource))
        : null;
      const status: ChartStatus = outcome === 'aggregated' && !aggregation ? 'cannot-aggregate' : outcome;
      const unit = aggregation ? (chart.measure.agg === 'count' ? 'count' : aggregation.unit ?? null) : null;
      charts.push({
        chartId: chart.id, chartTitle: chart.title, type: chart.type, source: chart.source, status,
        dimension: chart.dimension ?? null, stackBy: chart.stackBy ?? null,
        measure: { agg: chart.measure.agg, column: chart.measure.column ?? null }, unit,
        filter: filterSelector ?? null, clashRule: chartClashRule(chart) ?? null,
        recordedComparison: source.saved === 'comparison' ? source.name ?? null : null,
        // A saved clash report is past evidence: its gaps and its relation to the loaded models travel with every citation.
        savedClashReport: source.saved === 'clashReport' && source.status === 'saved' ? { name: source.report.name, savedAt: source.report.savedAt,
          truncated: !!source.report.completeness.truncated, stale: source.report.completeness.stale, loadedModelRevision: source.revision } : null,
        sliced: !!aggregation && chartCardSlice(chart, recorded, s.chartSlice, s.chartSliceSource) !== null,
        datasetRows: source.dataset.rows.length,
        bucketCount: aggregation?.categories.length ?? 0, seriesCount: aggregation?.series.length ?? 0,
        total: aggregation?.total ?? null,
        unbucketed: aggregation?.unbucketed ?? null, unmeasured: aggregation?.unmeasured ?? 0, unsupported: aggregation?.unsupported ?? 0,
      });
      if (!aggregation) continue;
      totalRows += aggregation.categories.length;
      for (const bucket of aggregation.categories) {
        if (rows.length >= limit) break;
        rows.push(evidenceRow({ kind: 'chart-bucket', unit }, {
          chartId: chart.id, chartTitle: chart.title, bucketKey: bucket.key, label: bucket.label,
          value: bucket.value, count: bucket.count, other: bucket.isOther === true,
        }));
      }
    }
    return {
      summary: {
        kind: 'chart-dashboard', dashboardId: dashboard.id, dashboardName: dashboard.name, scope: dashboard.scope.kind,
        chartCount: dashboard.charts.length, crossFilterActive: s.chartSlice !== null, crossFilterSourceChart: s.chartSliceSource,
        charts,
        limitations: 'Each chart has its own measure and unit; values are never comparable or summable across charts. Rows are category buckets (stacked series are folded into their category). Charts with an element filter are reported as filter-unresolved without buckets, because that filter resolves asynchronously in the panel. Unbucketed, unmeasured and unsupported counts are rows the chart could not place or measure, not zero values.',
      },
      totalRows,
      availability: 'available',
      rows,
    };
  },
};
