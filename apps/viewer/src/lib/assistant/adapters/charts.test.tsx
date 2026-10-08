/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Charts evidence (#6833): every chart of the active dashboard, aggregated by
 * the same pure card functions the Charts panel draws with, over the
 * committed sample. The chart renderer is a no-op recorder (no ECharts).
 */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { ELEMENT_COLUMNS, elementFieldColumnId, type DashboardSpec, type ElementFieldBinding } from '@ifc-lite/charts';
import { render, click, cleanup, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore, type FederatedModel } from '@/store';
import { modelOverviewDashboard, newChartSpec } from '@/lib/charts/presets';
import { createElementFieldReader } from '@/lib/charts/element-field-reader';
import { AssistantSourceContext } from '@/components/viewer/assistant/AssistantAction';
import { ChartsPanel } from '@/components/viewer/charts/ChartsPanel';
import type { ChartRenderer } from '@/components/viewer/charts/useEChart';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { cancelAssistant, useAssistant } from '../conversation';

const SAMPLE = new URL('../../../../public/samples/building-architecture.ifc', import.meta.url);
const initial = useViewerStore.getState();
const initialAssistant = useAssistant.getState();
afterEach(() => { cleanup(); cancelAssistant(); useAssistant.setState(initialAssistant, true); useViewerStore.setState(initial, true); });

let parsed: Promise<IfcDataStore> | null = null;
async function sampleModel(id = 'arch', idOffset = 0): Promise<FederatedModel> {
  parsed ??= readFile(SAMPLE).then(bytes => new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true }));
  return { ...fixtureModel(id, { idOffset }), name: `${id}.ifc`, ifcDataStore: await parsed, maxExpressId: 100_000 };
}

const silentRenderer: ChartRenderer = async () => () => ({ setOption: () => {}, select: () => {}, resize: () => {}, dispose: () => {} });
/** The wall-volume field as the chart editor discovers it (unit and measure type included). */
function wallVolume(store: IfcDataStore): ElementFieldBinding {
  const option = createElementFieldReader(store).discover([262]).quantities.get('Qto_WallBaseQuantities')
    ?.find(({ binding }) => binding.kind === 'quantity' && binding.quantityName === 'NetVolume');
  assert.ok(option, 'the sample wall carries NetVolume');
  return option.binding;
}

function seed(dashboard: DashboardSpec, ...models: FederatedModel[]): void {
  useViewerStore.setState({ ...fixtureModels(...models), dashboards: [dashboard], activeDashboardId: dashboard.id, unitDisplayOverrides: {} });
}

interface ChartSummary { chartId: string; status: string; unit: string | null; total: number | null; bucketCount: number; unbucketed: number | null; unmeasured: number; sliced: boolean }
interface BucketRow { chartId: string; label: string; value: number; count: number; unit: string | null }
const evidence = () => {
  const snapshot = captureEvidence('charts');
  const payload = JSON.parse(snapshot.payload);
  return { snapshot, payload, charts: (payload.evidence.summary?.charts ?? []) as ChartSummary[], rows: payload.evidence.rows.map((row: { data: BucketRow }) => row.data) as BucketRow[] };
};

test('#6833 charts: no dashboard is unavailable', async () => {
  useViewerStore.setState({ ...fixtureModels(await sampleModel()), dashboards: [], activeDashboardId: null });
  const { snapshot, payload } = evidence();
  assert.equal(payload.sourceAvailability, 'unavailable');
  assert.equal(snapshot.totalRows, 0);
});

test('#6833 charts: the panel action cites the buckets the cards draw, per chart unit, never summed across charts', async () => {
  const overview = modelOverviewDashboard();
  const model = await sampleModel();
  assert.ok(model.ifcDataStore);
  const field = wallVolume(model.ifcDataStore);
  const volume = newChartSpec({ title: 'Wall volume by type', type: 'bar', dimension: ELEMENT_COLUMNS.ifcType, measureField: field, measure: { agg: 'sum', column: elementFieldColumnId(field) } });
  const dashboard: DashboardSpec = { ...overview, charts: [...overview.charts, volume], layout: [...overview.layout, { chartId: volume.id, x: 0, y: 8, w: 12, h: 4 }] };
  seed(dashboard, model);
  const ui = render(<AssistantSourceContext panel="charts"><ChartsPanel renderer={silentRenderer} /></AssistantSourceContext>);
  await waitFor(() => ui.querySelectorAll('[data-chart-legend] li').length > 0, 'the cards aggregate');

  const button = ui.querySelector('button[aria-label="Discuss with AI"]');
  assert.ok(button, 'the Charts header offers Discuss with AI');
  click(button);
  const snapshot = useAssistant.getState().snapshot;
  assert.equal(snapshot?.source, 'charts');
  assert.ok(snapshot);
  const payload = JSON.parse(snapshot.payload);
  const charts = payload.evidence.summary.charts as ChartSummary[];
  const rows = payload.evidence.rows.map((row: { data: BucketRow }) => row.data) as BucketRow[];
  assert.equal(charts.length, 4);
  assert.equal(snapshot.totalRows, charts.reduce((sum, chart) => sum + chart.bucketCount, 0), 'every bucket of every chart is counted');

  // The first card's accessible legend is the card's own aggregation.
  const byType = overview.charts[0];
  const legend = [...ui.querySelectorAll(`[data-chart-id="${byType.id}"] [data-chart-legend] button`)].map(item => item.textContent);
  assert.ok(legend.length > 0);
  assert.deepEqual(rows.filter(row => row.chartId === byType.id).map(row => `${row.label}: ${row.value}`), legend);
  assert.ok(rows.filter(row => row.chartId === byType.id).every(row => row.unit === 'count'));

  const sum = charts.find(chart => chart.chartId === volume.id);
  assert.ok(sum);
  assert.equal(sum.status, 'aggregated');
  assert.equal(sum.unit, 'm³', 'a summed quantity carries its own unit');
  assert.ok(sum.unmeasured > 0, 'elements without a wall volume are counted as unmeasured, not zero');
  const wallRow = rows.find(row => row.chartId === volume.id && row.label === 'IfcWall');
  assert.ok(wallRow);
  assert.equal(wallRow.unit, 'm³');
  assert.ok(Math.abs(wallRow.value - (1.26926493526358 + 1.7856181822821586 + 4.230883117545889 + 0.16470195328802126)) < 1e-9);
  assert.equal(evidenceIsCurrent(snapshot), true);
  cleanup();
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(snapshot), false, 'an edit makes chart evidence stale');
});

test('#6833 charts: element filters are not shown unfiltered; the cross-chart slice and a dashboard edit change identity', async () => {
  const filtered = newChartSpec({ title: 'Filtered', type: 'bar', dimension: ELEMENT_COLUMNS.ifcType, filter: { selector: 'IfcWall' } });
  const byType = newChartSpec({ title: 'By type', type: 'bar', dimension: ELEMENT_COLUMNS.ifcType });
  const dashboard: DashboardSpec = { version: 2, id: 'd', name: 'D', scope: { kind: 'all' }, charts: [filtered, byType], layout: [] };
  seed(dashboard, await sampleModel());
  const before = evidence();
  const unresolved = before.charts.find(chart => chart.chartId === filtered.id);
  assert.equal(unresolved?.status, 'filter-unresolved');
  assert.equal(unresolved?.bucketCount, 0);
  assert.ok(before.rows.every(row => row.chartId === byType.id), 'no unfiltered buckets stand in for the filtered chart');

  const wallIds = new Set([262, 291, 315, 353]);
  useViewerStore.setState({ chartSlice: wallIds, chartSliceSource: filtered.id });
  assert.equal(evidenceIsCurrent(before.snapshot), false, 'a new cross-filter is a different result');
  const sliced = evidence();
  const slicedChart = sliced.charts.find(chart => chart.chartId === byType.id);
  assert.equal(slicedChart?.sliced, true);
  assert.deepEqual(sliced.rows.map(row => [row.label, row.value]), [['IfcWall', 4]]);

  useViewerStore.setState({ dashboards: [{ ...dashboard, charts: [byType] }] });
  assert.equal(evidenceIsCurrent(sliced.snapshot), false, 'an edited dashboard is a different result');
});

test('#6833 charts: many charts report exact bucket totals over a bounded sample across federated models', async () => {
  const charts = Array.from({ length: 40 }, (_, i) => newChartSpec({ title: `By name ${i}`, type: 'bar', dimension: ELEMENT_COLUMNS.name, topN: undefined }));
  seed({ version: 2, id: 'many', name: 'Many', scope: { kind: 'all' }, charts, layout: [] }, await sampleModel('a'), await sampleModel('b', 1_000_000));
  const { snapshot, payload, charts: summaries } = evidence();
  assert.equal(summaries.length, 40);
  const perChart = summaries[0].bucketCount;
  assert.ok(perChart > 3);
  assert.ok(summaries.every(chart => chart.bucketCount === perChart));
  assert.equal(snapshot.totalRows, 40 * perChart);
  assert.ok(snapshot.includedRows <= 100);
  assert.equal(payload.sampled, true);
  assert.ok(snapshot.payload.length <= 48_000);
});
