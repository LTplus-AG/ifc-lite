/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { aggregate, renderChartSvg } from '@ifc-lite/charts';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { useViewerStore } from '@/store';
import { seedAnalysisChart } from '@/test/analysis-chart-fixture';
import { parseChartProposal } from './chart-proposal';
import { isPreviewCurrent, previewArtifact } from './artifact-preview';
import { saveArtifact } from './artifact-save';
import { chartDatasetFromState } from '@/lib/charts/datasets/from-state';
import type { ChartSource } from '@ifc-lite/charts';
type AnalysisChartSource = Exclude<ChartSource, 'elements'>;

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
const proposal = (source: string, dimension: string, extra: Record<string, unknown> = {}) => parseChartProposal(JSON.stringify({ version: 1, kind: 'chart.proposal', title: 'Native analysis #7106',
  chart: { source, type: 'bar', dimension, measure: { agg: 'count' }, ...extra } }));
const cases: Array<[AnalysisChartSource, string]> = [['clash', 'Severity'], ['bcf', 'Status'], ['schedule', 'Phase'], ['ids', 'Result'], ['compare', 'State']];

for (const [source, dimension] of cases) {
  test(`#7106 ${source} proposal previews and saves the native producer's complete recorded rows`, async () => {
    await seedAnalysisChart(source);
    const state = useViewerStore.getState();
    const result = await previewArtifact(proposal(source, dimension), state);
    assert.equal(result.artifact.kind, 'chart.proposal');
    if (result.artifact.kind !== 'chart.proposal') throw new Error('Expected a chart artifact');
    const dataset = chartDatasetFromState(source, state, { kind: 'all' }, []);
    assert.ok(dataset.rows.length > 0, 'the native producer must actually have results');
    const direct = aggregate(result.artifact.spec, dataset);
    assert.equal(result.matched, dataset.rows.length);
    assert.equal(result.rowSource, source);
    assert.deepEqual(result.buckets.map(bucket => [bucket.label, bucket.count, bucket.value]), direct.categories.map(bucket => [bucket.label, bucket.count, bucket.value]));
    assert.equal(result.unassigned, direct.unbucketed);
    const svg = renderChartSvg({ aggregation: direct, width: 600, height: 360, showTitle: true });
    assert.match(svg, /<svg[ >]/, 'the saved native spec renders with the real chart engine');
    assert.doesNotMatch(svg, /NaN|Infinity/);
    assert.ok(svg.includes('Native analysis #7106'), 'the real vector chart carries its saved title');
    assert.ok(isPreviewCurrent(result, state));
    const saved = saveArtifact(result.artifact);
    assert.equal(saved.ok, true);
    const chart = useViewerStore.getState().dashboards.at(-1)?.charts.at(-1);
    assert.equal(chart?.source, source);
    assert.equal(chart?.dimension, dimension);
    assert.equal(useViewerStore.getState().models, state.models, 'saving a chart never mutates the models');
  });
}

test('#7106 native schedule sum records days and the real task-row denominator', async () => {
  await seedAnalysisChart('schedule');
  const result = await previewArtifact(proposal('schedule', 'Phase', { measure: { agg: 'sum', column: 'DurationDays' } }), useViewerStore.getState());
  assert.equal(result.matched, 2);
  assert.equal(result.measures[0].unit, 'days');
  assert.equal(result.measures[0].measured, 2);
  assert.equal(result.measures[0].rows, 2);
  assert.ok(result.measures[0].total > 0);
  assert.equal(result.population[0].count, 2, 'a task with two products remains one row per model');
});

test('#7106 native BCF closure timeline reports topics without closure dates and without loaded components', async () => {
  await seedAnalysisChart('bcf');
  const result = await previewArtifact(proposal('bcf', 'Closed', { type: 'timeline' }), useViewerStore.getState());
  assert.equal(result.matched, 2);
  assert.equal(result.unlinkedRows, 1);
  assert.equal(result.unassigned, 1);
  assert.deepEqual(result.buckets.map(bucket => [bucket.label, bucket.count]), [['2026-W37', 1]]);
});

for (const [source, dimension] of cases) {
  test(`#7106 ${source} refuses an unavailable native dataset and invented columns`, async () => {
    useViewerStore.setState({ clashResult: null, bcfProject: null, scheduleData: null, idsValidationReport: null, compareResult: null });
    await assert.rejects(previewArtifact(proposal(source, dimension), useViewerStore.getState()), /unavailable/);
    await seedAnalysisChart(source);
    await assert.rejects(previewArtifact(proposal(source, 'Invented7106'), useViewerStore.getState()), /has no dimension column/);
    await assert.rejects(previewArtifact(proposal(source, dimension, { measure: { agg: 'sum', column: dimension } }), useViewerStore.getState()), /must be numeric/);
  });
}

test('#7106 native source inputs withdraw review authority even when the dataset row count stays the same', async () => {
  for (const [source, dimension] of cases) {
    await seedAnalysisChart(source);
    const result = await previewArtifact(proposal(source, dimension), useViewerStore.getState());
    const state = useViewerStore.getState();
    if (source === 'clash') useViewerStore.setState({ clashResult: { ...state.clashResult! } });
    else if (source === 'bcf') useViewerStore.setState({ bcfProject: { ...state.bcfProject! } });
    else if (source === 'schedule') useViewerStore.setState({ playbackTime: state.playbackTime + 24 * 60 * 60 * 1000 });
    else if (source === 'ids') useViewerStore.setState({ idsValidationReport: { ...state.idsValidationReport! } });
    else useViewerStore.setState({ compareRunSeq: state.compareRunSeq + 1 });
    assert.equal(isPreviewCurrent(result, useViewerStore.getState()), false, source);
  }
});

test('#7106 rejects scope and field declarations that the native analysis builders cannot honor', () => {
  for (const [source, dimension] of cases) {
    assert.throws(() => parseChartProposal(JSON.stringify({ version: 1, kind: 'chart.proposal', title: 'T', scope: 'visible', chart: { source, type: 'bar', dimension, measure: { agg: 'count' } } })), /whole-analysis population/);
    assert.throws(() => proposal(source, dimension, { elementField: { kind: 'attribute', attributeName: 'Name' } }), /not IFC element fields/);
    assert.throws(() => proposal(source, dimension, { filter: { groups: [] } }), /do not yet support element filters/);
  }
});


test('#7106 known native stale analyses refuse a fresh chart review rather than pinning older rows as current', async () => {
  for (const source of ['clash', 'ids', 'compare'] as const) {
    await seedAnalysisChart(source);
    const state = useViewerStore.getState();
    const report = source === 'clash' ? state.clashRawResult ?? state.clashResult : source === 'ids' ? state.idsValidationReport : state.compareResult;
    assert.ok(report);
    stampAnalysisReport(report, captureAnalysisStamp(true));
    useViewerStore.setState({ geometryContentVersion: state.geometryContentVersion + 1 });
    await assert.rejects(previewArtifact(proposal(source, source === 'clash' ? 'Severity' : source === 'ids' ? 'Result' : 'State'), useViewerStore.getState()), /out of date/);
  }
});
