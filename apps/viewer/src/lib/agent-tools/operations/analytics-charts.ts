/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { digest } from '@ifc-lite/flow';
import { CHART_OVERLAY_LAYER_ID } from '@/lib/charts/renderer-selection';
import { isDashboardSpec, type Aggregation } from '@ifc-lite/charts';
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { parseDashboardFile } from '@/lib/charts/persistence';
import { selectNativeChartItems, clearNativeChartSelection } from '@/components/viewer/charts/useChart3DLink';
import { evaluateDashboardChart } from '@/lib/charts/evaluate-dashboard-chart';
import { sanitizeFilename } from '@/lib/export/download';
import { viewerOperation, emptySchema } from './contract';
import { matchesJsonSnapshot, metadata, idSchema, jsonSchema, artifactSchema, removedSchema, checkpoint } from './analytics-common';
function savedDashboard(id: string) {
  const row = useViewerStore.getState().dashboards.find(item => item.id === id);
  if (!row) throw new Error('Unknown dashboard.');
  return row;
}
function dashboard(id: string) { return structuredClone(savedDashboard(id)); }
function focusFingerprint(result: Aggregation): string {
  return digest([result.spec, result.dataFingerprint, result.series.map(series =>
    [series.key, series.buckets.map(bucket => [bucket.key, [...bucket.ids]])])]);
}
const targetSchema: JSONSchemaType<{ dashboard_id: string; chart_id: string }> = {
  type: 'object', properties: { dashboard_id: idSchema.properties.id, chart_id: idSchema.properties.id }, required: ['dashboard_id', 'chart_id'], additionalProperties: false,
};
export const analyticsChartOperations = [
  viewerOperation(metadata('charts.library', 'charts', 'Read native dashboard definitions, focus mode, 3D color setting and cross-filter selection.', ['read'], {
    type: 'object', properties: { dashboards: { type: 'array' }, activeId: { type: ['string', 'null'] }, focus: { type: 'string' }, colorIn3D: { type: 'boolean' }, slice: { type: ['array', 'null'] } }, required: ['dashboards', 'activeId', 'focus', 'colorIn3D', 'slice'], additionalProperties: false,
  }), emptySchema, () => { const s = useViewerStore.getState(); return { dashboards: s.dashboards, activeId: s.activeDashboardId, focus: s.chartFocusMode, colorIn3D: s.chartColorIn3D, slice: s.chartSlice ? [...s.chartSlice] : null }; }),
  viewerOperation<{ content_json: string }>(metadata('charts.import', 'charts', 'Import full native chart definitions, aggregation, source filters, scope and layout with native ID remapping. Native storage failures are reported explicitly.', ['configuration'], {
    type: 'object', properties: { id: { type: 'string' }, charts: { type: 'integer' } }, required: ['id', 'charts'], additionalProperties: false,
  }), jsonSchema, (i, c) => {
    const row = parseDashboardFile(i.content_json); checkpoint(c);
    if (!c.commit(() => useViewerStore.getState().upsertDashboard(row))) throw new Error('The dashboard change is applied in this session, but could not be saved. Inspect the dashboard library before retrying.');
    return { id: row.id, charts: row.charts.length };
  }),
  viewerOperation<{ id: string; expected_json: string; content_json: string }>(metadata('charts.replace', 'charts', 'Edit a full native dashboard/chart definition with an expected snapshot conflict check. Includes chart sources, measures, dimensions, filters, scope and layout.', ['configuration'], { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }), {
    type: 'object', properties: { id: idSchema.properties.id, expected_json: jsonSchema.properties.content_json, content_json: jsonSchema.properties.content_json }, required: ['id', 'expected_json', 'content_json'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; expected_json: string; content_json: string }>, (i, c) => {
    if (!matchesJsonSnapshot(dashboard(i.id), i.expected_json)) throw new Error('Dashboard changed since inspection.');
    const value: unknown = JSON.parse(i.content_json); if (!isDashboardSpec(value) || value.id !== i.id) throw new Error('Invalid native dashboard or changed ID.');
    checkpoint(c); if (!c.commit(() => useViewerStore.getState().upsertDashboard(value))) throw new Error('The dashboard change is applied in this session, but could not be saved. Inspect the dashboard library before retrying.'); return { id: i.id };
  }),
  viewerOperation<{ id: string }>(metadata('charts.delete', 'charts', 'Delete an existing dashboard through the native store.', ['configuration'], removedSchema), idSchema, (i, c) => {
    dashboard(i.id); checkpoint(c); if (!c.commit(() => useViewerStore.getState().deleteDashboard(i.id))) throw new Error('Native dashboard deletion failed.'); return { removed: i.id };
  }),
  viewerOperation<{ id: string; focus: 'highlight' | 'isolate' | 'ghost'; color_in_3d: boolean }>(metadata('charts.configure', 'charts', 'Select a dashboard and configure native chart focus and overlay behavior.', ['configuration', 'view'], {
    type: 'object', properties: { id: { type: 'string' }, focus: { type: 'string' }, color_in_3d: { type: 'boolean' } }, required: ['id', 'focus', 'color_in_3d'], additionalProperties: false,
  }), {
    type: 'object', properties: { id: idSchema.properties.id, focus: { type: 'string', enum: ['highlight', 'isolate', 'ghost'] }, color_in_3d: { type: 'boolean' } }, required: ['id', 'focus', 'color_in_3d'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; focus: 'highlight' | 'isolate' | 'ghost'; color_in_3d: boolean }>, (i, c) => {
    dashboard(i.id); checkpoint(c); c.commit(() => { const s = useViewerStore.getState(); s.setActiveDashboardId(i.id); s.setChartFocusMode(i.focus); s.setChartColorIn3D(i.color_in_3d); if (!i.color_in_3d) s.removeOverlayLayer(CHART_OVERLAY_LAYER_ID); }); return i;
  }),
  viewerOperation(metadata('charts.evaluate', 'charts', 'Await the same native aggregation/source/filter/slice used by a dashboard card. Return serializable bucket identities and source fingerprint.', ['read'], {
    type: 'object', properties: { spec: { type: 'object' }, dataFingerprint: { type: 'string' }, categories: { type: 'array' }, series: { type: 'array' }, total: { type: 'number' }, unbucketed: { type: 'number' }, categoryOf: { type: 'array' }, unit: { type: 'string' } }, required: ['spec', 'dataFingerprint', 'categories', 'series', 'total', 'unbucketed', 'categoryOf'],
  }), targetSchema, async (i, c) => { const result = await evaluateDashboardChart(dashboard(i.dashboard_id), i.chart_id, c.signal); checkpoint(c); return { ...result, dataFingerprint: focusFingerprint(result), categoryOf: [...result.categoryOf] }; }),
  viewerOperation<{ dashboard_id: string; chart_id: string; data_fingerprint: string; items: { seriesIndex: number; dataIndex: number }[] }>(metadata('charts.focusBuckets', 'charts', 'Resolve exact native chart marks, verify the inspected data fingerprint, and apply native highlight/isolate/ghost selection, cross-filter identities and optional 3D color overlays without mounting a chart.', ['read', 'selection', 'view'], { type: 'object', properties: { selected_ids: { type: 'array', items: { type: 'integer' } }, source: { type: ['string', 'null'] } }, required: ['selected_ids', 'source'], additionalProperties: false }), {
    type: 'object', properties: { dashboard_id: idSchema.properties.id, chart_id: idSchema.properties.id, data_fingerprint: { type: 'string', minLength: 1, maxLength: 10000 }, items: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { seriesIndex: { type: 'integer', minimum: 0 }, dataIndex: { type: 'integer', minimum: 0 } }, required: ['seriesIndex', 'dataIndex'], additionalProperties: false } } }, required: ['dashboard_id', 'chart_id', 'data_fingerprint', 'items'], additionalProperties: false,
  } satisfies JSONSchemaType<{ dashboard_id: string; chart_id: string; data_fingerprint: string; items: { seriesIndex: number; dataIndex: number }[] }>, async (i, c) => {
    const target = savedDashboard(i.dashboard_id);
    const aggregation = await evaluateDashboardChart(structuredClone(target), i.chart_id, c.signal);
    checkpoint(c);
    if (useViewerStore.getState().dashboards.find(row => row.id === i.dashboard_id) !== target) throw new Error('Chart dashboard changed during evaluation.');
    if (focusFingerprint(aggregation) !== i.data_fingerprint) throw new Error('Chart source changed since inspection.');
    if (i.items.some(item => !aggregation.series[item.seriesIndex]?.buckets[item.dataIndex])) throw new Error('Unknown chart mark.');
    c.commit(() => selectNativeChartItems(aggregation, i.items, useViewerStore.getState().chartFocusMode));
    const s = useViewerStore.getState(); return { selected_ids: [...s.selectedEntityIds], source: s.chartSliceSource };
  }),
  viewerOperation(metadata('charts.clearFocus', 'charts', 'Release native chart selection, owned visibility and 3D color overlay state.', ['selection', 'view'], { type: 'object', properties: { cleared: { type: 'boolean' } }, required: ['cleared'], additionalProperties: false }), emptySchema, (_, c) => { checkpoint(c); c.commit(clearNativeChartSelection); return { cleared: true }; }),
  viewerOperation(metadata('charts.exportSvg', 'charts', 'Await native chart aggregation and ECharts SVG rendering and return the actual SVG artifact.', ['read', 'artifact'], artifactSchema), targetSchema, async (i, c) => {
    const result = await evaluateDashboardChart(dashboard(i.dashboard_id), i.chart_id, c.signal); checkpoint(c);
    const { renderChartSvg } = await import('@ifc-lite/charts'); checkpoint(c);
    const svg = renderChartSvg({ aggregation: result, width: 1000, height: 600 }); checkpoint(c);
    return c.artifacts.create({ filename: `${sanitizeFilename(result.spec.title, { fallback: 'chart' })}.svg`, mimeType: 'image/svg+xml', data: svg });
  }),
];
