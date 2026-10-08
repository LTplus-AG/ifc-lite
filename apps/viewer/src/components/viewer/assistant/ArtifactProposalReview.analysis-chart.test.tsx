/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { render, click, cleanup, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { seedAnalysisChart } from '@/test/analysis-chart-fixture';
import { chartDatasetFromState } from '@/lib/charts/datasets/from-state';
import type { ChartSource } from '@ifc-lite/charts';
type AnalysisChartSource = Exclude<ChartSource, 'elements'>;
import { ArtifactProposalReview } from './ArtifactProposalReview';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); cancelAssistant(); useViewerStore.setState(initial, true); useAssistant.setState({ messages: [], snapshot: null, archived: null, status: 'idle', error: null }); });
const cases: Array<[AnalysisChartSource, string]> = [['clash', 'Severity'], ['bcf', 'Status'], ['schedule', 'Phase'], ['ids', 'Result'], ['compare', 'State']];
const saveButton = (ui: HTMLElement) => [...ui.querySelectorAll('button')].find(button => button.textContent === 'Save to a dashboard');
async function review(source: AnalysisChartSource, dimension: string) {
  await seedAnalysisChart(source);
  useViewerStore.setState({ dashboards: [], activeDashboardId: null });
  act(() => useAssistant.setState({ status: 'idle', error: null, messages: [{ role: 'assistant', model: 'recorded', content: JSON.stringify({ version: 1, kind: 'chart.proposal', title: 'Native analysis chart #7106', chart: { source, type: 'bar', dimension, measure: { agg: 'count' } } }) }] }));
  const ui = render(<ArtifactProposalReview onAsk={null} />);
  await waitFor(() => !!saveButton(ui) && !saveButton(ui)?.disabled, 'native chart review is saveable');
  return ui;
}

for (const [source, dimension] of cases) {
  test(`#7106 mounted ${source} review labels recorded rows and opens the saved native dashboard`, async () => {
    const ui = await review(source, dimension);
    const rows = chartDatasetFromState(source, useViewerStore.getState(), { kind: 'all' }, []).rows.length;
    assert.match(ui.textContent ?? '', new RegExp(`${rows} recorded row`));
    assert.match(ui.textContent ?? '', /Source:/);
    assert.doesNotMatch(ui.textContent ?? '', /chart of model elements|elements matched/);
    assert.equal(useViewerStore.getState().dashboards.length, 0);
    click(saveButton(ui)!);
    await waitFor(() => useViewerStore.getState().dashboards.length === 1, 'native dashboard save');
    const [dashboard] = useViewerStore.getState().dashboards;
    assert.equal(dashboard.charts[0].source, source);
    assert.equal(dashboard.charts[0].dimension, dimension);
    const open = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Open the dashboard');
    assert.ok(open, 'native artifact link is offered');
    click(open);
    assert.equal(useViewerStore.getState().activeDashboardId, dashboard.id);
  });
}

test('#7106 source replacement withdraws mounted save authority before a stale click can save', async () => {
  const ui = await review('clash', 'Severity');
  const staleSave = saveButton(ui);
  assert.ok(staleSave);
  act(() => useViewerStore.setState({ clashResult: null }));
  click(staleSave);
  await waitFor(() => /unavailable/.test(ui.textContent ?? ''), 'the native source refusal appears');
  assert.equal(useViewerStore.getState().dashboards.length, 0);
  assert.equal(saveButton(ui)?.disabled ?? true, true);
});

test('#7106 native BCF edit reruns the mounted chart without a new model revision', async () => {
  const ui = await review('bcf', 'Status');
  const state = useViewerStore.getState();
  const topic = [...state.bcfProject!.topics.values()].find(topic => topic.topicStatus === 'Open');
  assert.ok(topic);
  act(() => state.updateTopic(topic.guid, { topicStatus: 'Closed' }));
  await waitFor(() => !saveButton(ui)?.disabled && ![...ui.querySelectorAll('td')].some(cell => cell.textContent === 'Open'), 'native topic edit refreshes bucket rows');
  const closedRow = [...ui.querySelectorAll('tr')].find(row => row.querySelector('td')?.textContent === 'Closed');
  assert.match(closedRow?.textContent ?? '', /Closed2/);
  assert.equal(useViewerStore.getState().mutationVersion, state.mutationVersion);
});

test('#7106 native model rename refreshes analysis population labels and restores save authority', async () => {
  const ui = await review('bcf', 'Status');
  const state = useViewerStore.getState();
  const model = [...state.models.values()][0];
  act(() => state.updateModel(model.id, { name: 'Renamed chart source #7106' }));
  await waitFor(() => !!saveButton(ui) && !saveButton(ui)?.disabled && /Renamed chart source #7106/.test(ui.textContent ?? ''), 'native model change refreshes the analysis preview');
  assert.equal(useViewerStore.getState().bcfProject, state.bcfProject, 'the BCF topic source itself did not change');
  click(saveButton(ui)!);
  assert.equal(useViewerStore.getState().dashboards.length, 1);
});
