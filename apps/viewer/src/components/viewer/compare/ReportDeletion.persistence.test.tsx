/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { readContentRows, writeContent } from '@/lib/storage/content-database';
import { saveDashboards, loadDashboards } from '@/lib/charts/persistence';
import { click, render, waitFor } from '@/test/render';
import { button, dependents, realComparison, setupReportDeletionFixtures } from '@/test/report-deletion-fixture';
import { SavedComparisonLibrary } from './SavedComparisonLibrary';

setupReportDeletionFixtures();
const DASHBOARDS_KEY = 'ifc-lite-dashboards';
async function preview(reportId: string) {
  const ui = render(<SavedComparisonLibrary result={null} running={false} />);
  const picker = ui.querySelector('select'); assert.ok(picker);
  act(() => { picker.value = reportId; picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
  const remove = button(ui, 'Delete saved comparison'); assert.ok(remove); click(remove);
  await waitFor(() => button(ui, 'Delete report')?.disabled === false, 'real report confirmation has hydrated native Document dependencies');
  return ui;
}
function newerStoredDashboard() {
  const current = useViewerStore.getState().dashboards[0]; assert.ok(current);
  assert.ok(current.charts[0]);
  const newer = { ...current, charts: [...current.charts,
    { ...current.charts[0], id: 'persisted-new-reference', title: 'Newer persisted report reference' }] };
  // Another tab's actual storage write must not overwrite this tab's session draft.
  saveDashboards([newer]);
  assert.equal(loadDashboards()[0]?.charts.length, 2, 'canonical dashboard persistence retained the newer native reference');
  assert.equal(useViewerStore.getState().dashboards[0], current, 'the active native session remains genuinely stale');
  return current;
}

for (const count of [1, 2]) test(`#7245 mounted deletion preview uses ${count === 1 ? 'singular' : 'plural'} readable chart-reference text`, async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const document = useViewerStore.getState().documents[0]; assert.ok(document);
  assert.equal(await useViewerStore.getState().deleteDocument(document.id), true);
  const dashboard = useViewerStore.getState().dashboards[0]; assert.ok(dashboard?.charts[0]);
  act(() => useViewerStore.getState().upsertDashboard({ ...dashboard,
    charts: Array.from({ length: count }, (_, index) => ({ ...dashboard.charts[0], id: `count-reference-${index}` })),
  }));
  const ui = await preview(report.id);
  assert.match(ui.textContent ?? '', count === 1
    ? /1 chart reference found in readable libraries, including current unsaved entries\./
    : /2 chart references found in readable libraries, including current unsaved entries\./);
  if (count === 1) assert.doesNotMatch(ui.textContent ?? '', /1 chart references/);
  assert.equal(ui.querySelectorAll('[data-report-deletion-preview] li').length, count);
  assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false);
});

test('#7245 same-ID newer persisted dashboard references and current unsaved references both appear in native deletion preview', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const current = newerStoredDashboard();
  const ui = await preview(report.id);
  assert.match(ui.textContent ?? '', /3 chart references found/, 'one current dashboard chart, its new persisted peer and the native Document chart all remain covered');
  assert.match(ui.textContent ?? '', /Newer persisted report reference/);
  assert.match(ui.textContent ?? '', /External report chart/);
  assert.match(ui.textContent ?? '', /Document report chart/);
  assert.equal(useViewerStore.getState().dashboards[0], current, 'preview does not hydrate over the current unsaved version');
  assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false);
});

test('#7245 a current same-ID chart retargeted to another report cannot hide its durable original report reference', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const other = await realComparison(); assert.notEqual(other.id, report.id);
  const original = useViewerStore.getState().dashboards[0]; assert.ok(original?.charts[0]);
  const session = { ...original, charts: [
    { ...original.charts[0], comparisonId: other.id, title: 'Retargeted current chart' },
    { ...original.charts[0], id: 'current-only-reference', title: 'Current unsaved original report reference' },
  ] };
  useViewerStore.getState().upsertDashboard(session);
  // This later external write preserves the original chart ID/source independently.
  saveDashboards([original]);
  assert.equal(loadDashboards()[0]?.charts[0]?.comparisonId, report.id);
  assert.equal(useViewerStore.getState().dashboards[0]?.charts[0]?.comparisonId, other.id);
  const ui = await preview(report.id);
  assert.match(ui.textContent ?? '', /3 chart references found/, 'durable original chart, current-only original chart and native Document are all covered');
  assert.match(ui.textContent ?? '', /External report chart/);
  assert.match(ui.textContent ?? '', /Current unsaved original report reference/);
  assert.doesNotMatch(ui.textContent ?? '', /Retargeted current chart/, 'the other real report is not a dependency of this source');
  assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false);
});

test('#7245 same-ID persisted reference added after native acknowledgement revokes deletion until the changed list is reviewed', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const ui = await preview(report.id);
  assert.match(ui.textContent ?? '', /2 chart references found/);
  newerStoredDashboard();
  await act(async () => { window.dispatchEvent(new window.StorageEvent('storage', { key: DASHBOARDS_KEY, newValue: localStorage.getItem(DASHBOARDS_KEY) })); });
  assert.match(ui.textContent ?? '', /Chart references changed/, 'a stale session dashboard cannot mask the durable dependency change');
  const confirm = button(ui, 'Delete report'); assert.ok(confirm);
  assert.equal(confirm.disabled, true, 'the original captured acknowledgement no longer authorizes native removal');
  click(confirm);
  assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false, 'revoked native confirmation preserves its actual durable source');
  assert.equal(loadDashboards()[0]?.charts[1]?.comparisonId, report.id, 'the new persisted dependent remains bound to its retained report');
});

test('#7245 an empty-string persisted dashboard value is unreadable coverage in the mounted native deletion preview', async () => {
  const report = await realComparison();
  localStorage.setItem(DASHBOARDS_KEY, '');
  const ui = await preview(report.id);
  assert.match(ui.textContent ?? '', /0 chart references found/);
  assert.match(ui.textContent ?? '', /Some saved libraries could not be read completely/, 'present malformed storage cannot certify an empty dashboard library');
  assert.equal(localStorage.getItem(DASHBOARDS_KEY), '', 'preview preserves the unreadable original');
  assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false);
});

for (const raw of [null, '[]']) test(`#7245 ${raw === null ? 'absent' : 'readable empty'} dashboard storage remains an explicit known-zero native control`, async () => {
  const report = await realComparison();
  if (raw === null) localStorage.removeItem(DASHBOARDS_KEY); else localStorage.setItem(DASHBOARDS_KEY, raw);
  const ui = await preview(report.id);
  assert.match(ui.textContent ?? '', /0 chart references found/);
  assert.doesNotMatch(ui.textContent ?? '', /Some saved libraries could not be read completely/);
  assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false);
});

async function addDurableDocumentReference() {
  const current = useViewerStore.getState().documents[0]; assert.ok(current);
  const chart = current.blocks.find(block => block.kind === 'chart'); assert.ok(chart);
  const saved = { ...current, blocks: [...current.blocks, { ...chart, id: 'external-document-reference', chart: { ...chart.chart, id: 'external-document-chart', title: 'New durable Document reference' } }] };
  const row = (await readContentRows('document')).find(entry => entry.id === current.id); assert.ok(row);
  assert.equal((await writeContent('document', current.id, saved, row.revision)).ok, true);
  assert.equal(useViewerStore.getState().documents[0], current, 'native view remains genuinely stale after another tab writes');
}

test('#7252 a Document saved after native hydration is refreshed before mounted dependency acknowledgement', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  await addDurableDocumentReference();
  const ui = await preview(report.id);
  assert.match(ui.textContent ?? '', /3 chart references found/);
  assert.match(ui.textContent ?? '', /New durable Document reference/);
  assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false);
});

test('#7252 final native Delete refreshes a late durable Document and revokes its stale acknowledgement', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const ui = await preview(report.id);
  assert.match(ui.textContent ?? '', /2 chart references found/);
  await addDurableDocumentReference();
  const remove = button(ui, 'Delete report'); assert.ok(remove); assert.equal(remove.disabled, false);
  click(remove);
  await waitFor(() => /Chart references changed/.test(ui.textContent ?? ''), 'late durable Document revokes native deletion approval');
  assert.match(ui.textContent ?? '', /New durable Document reference/);
  assert.equal(button(ui, 'Delete report')?.disabled, true);
  assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false);
});

test('#7252 durable same-ID Document references and current unsaved retargeted drafts both remain covered', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const other = await realComparison();
  const current = useViewerStore.getState().documents[0]; assert.ok(current);
  const chart = current.blocks.find(block => block.kind === 'chart'); assert.ok(chart);
  const draft = { ...current, blocks: [
    { ...chart, chart: { ...chart.chart, comparisonId: other.id, title: 'Retargeted unsaved Document chart' } },
    { ...chart, id: 'unsaved-document-reference', chart: { ...chart.chart, id: 'unsaved-chart', title: 'Current unsaved Document reference' } },
  ] };
  await addDurableDocumentReference();
  act(() => useViewerStore.getState().stageDocument(draft));
  const ui = await preview(report.id);
  assert.match(ui.textContent ?? '', /4 chart references found/);
  assert.match(ui.textContent ?? '', /Document report chart/);
  assert.match(ui.textContent ?? '', /New durable Document reference/);
  assert.match(ui.textContent ?? '', /Current unsaved Document reference/);
  assert.doesNotMatch(ui.textContent ?? '', /Retargeted unsaved Document chart/);
  assert.equal(useViewerStore.getState().documents[0], draft, 'durable dependency reads never overwrite the native unsaved draft');
});
