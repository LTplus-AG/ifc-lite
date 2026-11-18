/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Aggregation, ReportSpec } from '@ifc-lite/charts';
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { evaluateDashboardChart } from '@/lib/charts/evaluate-dashboard-chart';
import { exportPreparedChartReport } from '@/lib/export/report/export-prepared-chart-report';
import { reportTitleBlock } from '@/lib/export/report/settings';
import { largestBucketIds } from '@/lib/charts/buckets';
import { isRecordedChart, chartSourceContext, resolveChartSource } from '@/lib/charts/chart-source';
import { chartSourceMessage } from '@/lib/charts/chart-source-message';
import { resolve } from '@/i18n/registry';
import { captureAnalysisStamp, isAnalysisStale } from '@/hooks/useAnalysisStaleness';
import { sanitizeFilename } from '@/lib/export/download';
import { viewerOperation } from './contract';
import { metadata, idSchema, artifactSchema, checkpoint } from './analytics-common';
interface Input { id: string; expected_json: string; page: { size: 'A4' | 'A3'; orientation: 'portrait' | 'landscape' }; title_block: { project: string; title: string; author: string; date: string; revision: string }; snapshots: boolean; save_setup: boolean }
export const analyticsChartReportOperations = [
  viewerOperation<Input>(metadata('charts.exportReport', 'charts', 'Await all native chart datasets/filters, real multi-chart report PDF, optional restored viewport captures and native report setup persistence. Exposes the actual Report dialog paper/orientation/title-block/snapshot controls without mounting it.', ['read', 'artifact', 'configuration', 'view'], {
    type: 'object', properties: { artifact: artifactSchema, pages: { type: 'integer' }, charts: { type: 'integer' }, snapshots: { type: 'integer' }, snapshot_failures: { type: 'array', items: { type: 'string' } } }, required: ['artifact', 'pages', 'charts', 'snapshots', 'snapshot_failures'], additionalProperties: false,
  }), {
    type: 'object', properties: { id: idSchema.properties.id, expected_json: { type: 'string', minLength: 2, maxLength: 500000 },
      page: { type: 'object', properties: { size: { type: 'string', enum: ['A4', 'A3'] }, orientation: { type: 'string', enum: ['portrait', 'landscape'] } }, required: ['size', 'orientation'], additionalProperties: false },
      title_block: { type: 'object', properties: { project: { type: 'string', maxLength: 10000 }, title: { type: 'string', maxLength: 10000 }, author: { type: 'string', maxLength: 10000 }, date: { type: 'string', maxLength: 1000 }, revision: { type: 'string', maxLength: 1000 } }, required: ['project', 'title', 'author', 'date', 'revision'], additionalProperties: false }, snapshots: { type: 'boolean' }, save_setup: { type: 'boolean' },
    }, required: ['id', 'expected_json', 'page', 'title_block', 'snapshots', 'save_setup'], additionalProperties: false,
  } satisfies JSONSchemaType<Input>, async (i, c) => {
    const state = useViewerStore.getState(); const dashboard = state.dashboards.find(row => row.id === i.id);
    if (!dashboard || JSON.stringify(dashboard) !== JSON.stringify(JSON.parse(i.expected_json))) throw new Error('Dashboard changed since inspection.');
    const frozen = structuredClone(dashboard); const stamp = captureAnalysisStamp(true);
    const { chartSlice, chartSliceSource } = useViewerStore.getState();
    const aggregations = new Map<string, Aggregation | null>();
    for (const chart of frozen.charts) { checkpoint(c); aggregations.set(chart.id, await evaluateDashboardChart(frozen, chart.id, c.signal)); }
    const result = await exportPreparedChartReport({ name: frozen.name, page: i.page, titleBlock: reportTitleBlock(i.title_block), snapshots: i.snapshots,
      charts: frozen.charts.map(chart => ({ id: chart.id, title: chart.title, aggregation: aggregations.get(chart.id) ?? null, snapshot: !isRecordedChart(chart),
        message: chartSourceMessage(resolveChartSource(chart, { source: chart.source, columns: [], rows: [], fingerprint: '' }, chartSourceContext(state)), resolve) })),
      snapshotIds: id => largestBucketIds(aggregations.get(id)),
    }, { signal: c.signal }); checkpoint(c);
    const now = useViewerStore.getState();
    if (isAnalysisStale(stamp, now) || now.chartSlice !== chartSlice || now.chartSliceSource !== chartSliceSource
      || JSON.stringify(now.dashboards.find(row => row.id === i.id)) !== JSON.stringify(frozen)) throw new Error('Report source changed during rendering. Discarded artifact.');
    const saved: ReportSpec = { ...frozen, page: i.page, titleBlock: i.title_block, snapshots: i.snapshots };
    if (i.save_setup && !c.commit(() => useViewerStore.getState().upsertDashboard(saved))) throw new Error('Native report setup persistence failed.');
    const artifact = await c.artifacts.create({ filename: `${sanitizeFilename(frozen.name, { fallback: 'report' })}-report.pdf`, mimeType: 'application/pdf', data: result.blob });
    return { artifact, pages: result.pages, charts: result.charts, snapshots: result.snapshots, snapshot_failures: result.snapshotFailures };
  }),
];
