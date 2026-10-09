/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { aggregate } from '@ifc-lite/charts';
import { chartSourceContext, resolveChartSource } from '@/lib/charts/chart-source';
import { readContentRows } from '@/lib/storage/content-database';
import { useViewerStore } from '@/store';
import { click, render, waitFor } from '@/test/render';
import { refuseContentWrites } from '@/test/content-fixture';
import { detectCoincidentWalls, mountClashPanel, saveCurrentResultAs } from '@/test/clash-report-fixture';
import { button, dependents, realComparison, setupReportDeletionFixtures } from '@/test/report-deletion-fixture';
import { SavedComparisonLibrary } from './SavedComparisonLibrary';

setupReportDeletionFixtures();
test('#7245 native comparison Delete previews its actual dashboard and Document chart dependents before removal', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const ui = render(<SavedComparisonLibrary result={null} running={false} />);
  const picker = ui.querySelector('select'); assert.ok(picker);
  act(() => { picker.value = report.id; picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
  const remove = button(ui, 'Delete saved comparison'); assert.ok(remove); click(remove);
  assert.ok(ui.querySelector('[data-report-deletion-preview]'), 'native Delete opens its dependency preview');
  assert.match(ui.textContent ?? '', /Affected dashboard/); assert.match(ui.textContent ?? '', /Affected document/);
  assert.ok(useViewerStore.getState().savedComparisons.some(row => row.id === report.id), 'preview does not delete the source');
});
test('#7245 native clash Delete previews actual report-chart dependents, not only a generic warning', async () => {
  mountClashPanel(); await detectCoincidentWalls(2);
  const report = await saveCurrentResultAs('Actual coincident wall report');
  assert.equal(report.clashes.length, 1); await dependents('clash', report.id);
  const row = document.body.querySelector(`[data-clash-report="${report.id}"]`); assert.ok(row);
  const remove = button(row, 'Delete'); assert.ok(remove); click(remove);
  assert.ok(row.querySelector('[data-report-deletion-preview]'), 'native clash Delete opens its dependency preview');
  assert.match(row.textContent ?? '', /Affected dashboard/); assert.match(row.textContent ?? '', /Affected document/);
  assert.ok(useViewerStore.getState().savedClashReports.some(entry => entry.id === report.id));
});


test('#7245 independent native saved-report chart remains readable before deletion', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const ui = render(<SavedComparisonLibrary result={null} running={false} />);
  assert.ok([...ui.querySelectorAll('option')].some(option => option.value === report.id), 'the existing native picker can read the durable real comparison');
  const row = (await readContentRows('comparison')).find(entry => entry.id === report.id);
  assert.ok(row && !row.deleted);
  const chart = useViewerStore.getState().dashboards[0].charts[0];
  const bound = resolveChartSource(chart, { source: 'compare', columns: [], rows: [], fingerprint: 'empty-live-control' }, chartSourceContext(useViewerStore.getState()));
  assert.ok(aggregate(chart, bound.dataset).total > 0, 'independent chart still reads the parsed IFC revision evidence');
});

// #7245: approval belongs to the mounted public dialog until durable completion.
test('#7245 mounted native clash deletion retains approval through real quota failure and Retry', async () => {
  mountClashPanel(); await detectCoincidentWalls(2);
  const report = await saveCurrentResultAs('Native mounted quota retry');
  assert.equal(report.clashes.length, 1); await dependents('clash', report.id);
  const row = document.body.querySelector(`[data-clash-report="${report.id}"]`); assert.ok(row);
  click(button(row, 'Delete')!);
  await waitFor(() => button(row, 'Delete report')?.disabled === false, 'native dependency preview becomes ready');
  const beforeModels = useViewerStore.getState().models;
  const beforeVersion = useViewerStore.getState().mutationVersion;
  const refused = refuseContentWrites();
  try {
    click(button(row, 'Delete report')!);
    await waitFor(() => useViewerStore.getState().savedClashReportsStorage.items[report.id] === 'quota', 'real native quota refusal');
    assert.equal((await readContentRows('clashReports')).find(entry => entry.id === report.id)?.deleted, false);
  } finally { refused.mock.restore(); }
  assert.equal(await useViewerStore.getState().retrySaveClashReports(), true, 'mounted public approval survives native quota Retry');
  assert.equal((await readContentRows('clashReports')).find(entry => entry.id === report.id)?.deleted, true);
  assert.equal(useViewerStore.getState().models, beforeModels);
  assert.equal(useViewerStore.getState().mutationVersion, beforeVersion);
});
