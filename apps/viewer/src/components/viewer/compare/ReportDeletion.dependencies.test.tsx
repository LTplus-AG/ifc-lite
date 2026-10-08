/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { clearContentDatabase, refuseContentWrites } from '@/test/content-fixture.js';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { diffModels } from '@ifc-lite/diff';
import type { ChartSpec } from '@ifc-lite/charts';
import { buildEntityFingerprints } from '@/lib/compare/buildFingerprints';
import { snapshotComparison } from '@/lib/compare/savedComparisons';
import { blankDocument } from '@/lib/document/presets';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { click, render, cleanup, waitFor } from '@/test/render';
import { detectCoincidentWalls, mountClashPanel, saveCurrentResultAs } from '@/test/clash-report-fixture';
import { readContentRows, writeContent } from '@/lib/storage/content-database';
import { createDocumentSlice } from '@/store/slices/documentSlice';
import { ReportDeletionPreview } from '../ReportDeletionPreview';
import { SavedComparisonLibrary } from './SavedComparisonLibrary';

const original = useViewerStore.getState();
const button = (root: ParentNode, name: string) => [...root.querySelectorAll('button')].find(node => node.textContent?.trim() === name);
beforeEach(async () => { localStorage.clear(); await clearContentDatabase(); useViewerStore.setState({ dashboards: [], documents: [] }); });
afterEach(() => { cleanup(); useViewerStore.setState(original); localStorage.clear(); });
async function dependents(source: 'compare' | 'clash', id: string) {
  const spec: ChartSpec = { id: 'dependent-chart', title: 'External report chart', source, type: 'bar', dimension: 'State', measure: { agg: 'count' },
    ...(source === 'compare' ? { comparisonId: id } : { clashReportId: id }) };
  useViewerStore.getState().upsertDashboard({ version: 2, id: 'dependent-dashboard', name: 'Affected dashboard', scope: { kind: 'all' }, charts: [spec], layout: [] });
  await useViewerStore.getState().initializeDocuments();
  const document = { ...blankDocument(), name: 'Affected document', blocks: [{ kind: 'chart' as const, id: 'dependent-block', snapshot: true, chart: { ...spec, title: 'Document report chart' } }] };
  assert.equal(await useViewerStore.getState().upsertDocument(document), true);
  assert.equal(useViewerStore.getState().dashboards[0].charts[0].source, source);
  assert.equal(useViewerStore.getState().documents.find(row => row.id === document.id)?.blocks[0].kind, 'chart');
}
async function realComparison() {
  const models = await Promise.all(['A', 'B'].map(async id => {
    const bytes = await readFile(new URL(`../../../../public/samples/building-architecture${id === 'B' ? '-rev-b' : ''}.ifc`, import.meta.url));
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return { ...fixtureModel(id), ifcDataStore: store };
  }));
  const fingerprints = await Promise.all(models.map(model => buildEntityFingerprints({ modelId: model.id, store: model.ifcDataStore, meshes: [], idOffset: model.idOffset })));
  const diff = diffModels(fingerprints[0], fingerprints[1], { scope: 'data' });
  const federation = fixtureModels(...models); useViewerStore.setState(federation);
  const report = snapshotComparison({ baseModelId: 'A', headModelId: 'B', baseName: 'A', headName: 'B', scope: 'data', geometryUnavailable: true,
    excludedHiddenIds: new Set(), mutationVersion: 0, diff }, federation.models, 'Actual SketchUp revision pair');
  assert.ok(report.report.rows.some(row => row.state === 'added'));
  assert.ok(report.report.rows.some(row => row.state === 'deleted'));
  await useViewerStore.getState().initializeSavedComparisons();
  assert.equal(await useViewerStore.getState().saveComparison(report), true);
  return report;
}
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

const settle = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };
function previewFor(report: Awaited<ReturnType<typeof realComparison>>) {
  return render(<ReportDeletionPreview source={{ kind: 'compare', id: report.id }} report={report} onCancel={() => {}} storageFailed={() => {}} />);
}
test('#7245 dependency changes require explicit review again and Cancel preserves the actual source', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const ui = render(<SavedComparisonLibrary result={null} running={false} />);
  const picker = ui.querySelector('select'); assert.ok(picker);
  act(() => { picker.value = report.id; picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
  click(button(ui, 'Delete saved comparison')!); await settle();
  assert.equal(button(ui, 'Delete report')?.disabled, false);
  const dashboard = useViewerStore.getState().dashboards[0];
  act(() => useViewerStore.getState().upsertDashboard({ ...dashboard, name: 'Changed owner dashboard' }));
  assert.match(ui.textContent ?? '', /references changed/); assert.equal(button(ui, 'Delete report')?.disabled, true);
  click(button(ui, 'Review updated references')!); assert.equal(button(ui, 'Delete report')?.disabled, false);
  click(button(ui, 'Keep')!);
  assert.equal(ui.querySelector('[data-report-deletion-preview]'), null);
  assert.ok(useViewerStore.getState().savedComparisons.some(row => row.id === report.id));
});
test('#7245 same-ID native rename invalidates the captured source instead of deleting its replacement', async () => {
  const report = await realComparison(); const ui = previewFor(report); await settle();
  await act(async () => { assert.equal(await useViewerStore.getState().renameSavedComparison(report.id, 'New source revision'), true); });
  assert.match(ui.textContent ?? '', /report changed or was replaced/); assert.equal(button(ui, 'Delete report')?.disabled, true);
  assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false);
});
test('#7245 native revision CAS refuses a replacement invisible to the preview at async durable deletion', async () => {
  const report = await realComparison(); const ui = previewFor(report); await settle();
  const row = (await readContentRows('comparison')).find(entry => entry.id === report.id); assert.ok(row);
  assert.equal((await writeContent('comparison', report.id, { ...report, name: 'Other tab replacement' }, row.revision)).ok, true);
  // The old native session still owns its old report pointer. Only the real async storage CAS sees the replacement.
  assert.equal(useViewerStore.getState().savedComparisons.find(entry => entry.id === report.id), report);
  click(button(ui, 'Delete report')!);
  await waitFor(() => useViewerStore.getState().savedComparisonsStorage.items[report.id] === 'conflict', 'native deletion reports revision conflict');
  const persisted = (await readContentRows('comparison')).find(entry => entry.id === report.id); assert.ok(persisted && !persisted.deleted);
  assert.equal((persisted.payload as { name: string }).name, 'Other tab replacement');
  assert.equal(await useViewerStore.getState().retrySaveComparisons(), false, 'retry cannot silently erase the replacement');
});
test('#7245 actual storage quota refusal preserves durable report and native Retry recovers deletion', async () => {
  const report = await realComparison(); const ui = previewFor(report); await settle();
  const refused = refuseContentWrites();
  try {
    click(button(ui, 'Delete report')!);
    await waitFor(() => useViewerStore.getState().savedComparisonsStorage.items[report.id] === 'quota', 'native deletion refuses quota');
    assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false);
  } finally { refused.mock.restore(); }
  assert.equal(await useViewerStore.getState().retrySaveComparisons(), true);
  assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, true);
});
test('#7245 damaged dashboard storage discloses unknown dependencies without claiming an empty readable library', async () => {
  const report = await realComparison(); localStorage.setItem('ifc-lite-dashboards', '{not-json');
  const ui = previewFor(report); await settle();
  assert.match(ui.textContent ?? '', /could not be read completely/); assert.match(ui.textContent ?? '', /More chart references may exist/);
  assert.equal(button(ui, 'Delete report')?.disabled, false, 'informed deletion is still allowed');
});
test('#7245 full reference counts survive bounded display and exclude other report IDs and embedded history', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const dashboard = useViewerStore.getState().dashboards[0], chart = dashboard.charts[0];
  act(() => useViewerStore.getState().upsertDashboard({ ...dashboard, charts: [
    ...Array.from({ length: 25 }, (_, i) => ({ ...chart, id: `actual-ref-${i}`, title: `Report chart ${i}` })),
    { ...chart, id: 'unrelated', title: 'Other saved source', comparisonId: 'other-report' },
    { ...chart, id: 'latest', title: 'Current comparison', comparisonId: undefined },
  ] }));
  const document = { ...blankDocument(), name: 'Independent embedded comparison', blocks: [{ kind: 'table' as const, id: 'embedded', source: { kind: 'comparison' as const, comparison: report } }] };
  assert.equal(await useViewerStore.getState().upsertDocument(document), true);
  const ui = previewFor(report); await settle();
  assert.match(ui.textContent ?? '', /26 chart references/); assert.match(ui.textContent ?? '', /Showing 20 of 26/);
  assert.equal(ui.querySelectorAll('li').length, 20);
  assert.doesNotMatch(ui.textContent ?? '', /Independent embedded comparison|Other saved source|Current comparison/);
});

test('#7245 native Document hydration distinguishes loading and unavailable from an empty dependency set', async () => {
  const report = await realComparison();
  useViewerStore.setState(createDocumentSlice(useViewerStore.setState, useViewerStore.getState, useViewerStore));
  const transact = IDBDatabase.prototype.transaction;
  const unavailable = mock.method(IDBDatabase.prototype, 'transaction', function(this: IDBDatabase, stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
    if ((mode ?? 'readonly') === 'readonly' && (typeof stores === 'string' ? stores === 'items' : stores.includes('items'))) throw new DOMException('Unavailable native read', 'InvalidStateError');
    return transact.call(this, stores, mode, options);
  });
  try {
    const ui = previewFor(report);
    assert.match(ui.textContent ?? '', /Documents are still loading/); assert.equal(button(ui, 'Delete report')?.disabled, true);
    await waitFor(() => useViewerStore.getState().documentsStorage.phase === 'unavailable', 'actual Document read failure is published');
    await settle();
    assert.match(ui.textContent ?? '', /More chart references may exist/);
    assert.doesNotMatch(ui.textContent ?? '', /Documents are still loading/);
    assert.equal(button(ui, 'Delete report')?.disabled, false);
  } finally { unavailable.mock.restore(); }
});
test('#7245 native unsaved Document chart edits participate even when their durable save was refused', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const originalDocument = useViewerStore.getState().documents[0];
  const draft = { ...originalDocument, id: 'quota-dependent-draft', name: 'Unsaved affected Document' };
  const refused = refuseContentWrites();
  try { assert.equal(await useViewerStore.getState().upsertDocument(draft), false); } finally { refused.mock.restore(); }
  assert.equal((await readContentRows('document')).some(row => row.id === draft.id), false);
  const ui = previewFor(report); await settle();
  assert.match(ui.textContent ?? '', /3 chart references/); assert.match(ui.textContent ?? '', /Unsaved affected Document/);
});
test('#7245 a readable genuinely empty native catalogue makes zero references explicit', async () => {
  const report = await realComparison(); const ui = previewFor(report); await settle();
  assert.match(ui.textContent ?? '', /0 chart references found in readable libraries/);
  assert.doesNotMatch(ui.textContent ?? '', /More chart references may exist|still loading/);
  assert.equal(button(ui, 'Delete report')?.disabled, false);
});
test('#7245 partially invalid native dashboard storage retains readable references and discloses omissions', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  localStorage.setItem('ifc-lite-dashboards', JSON.stringify([useViewerStore.getState().dashboards[0], null]));
  const ui = previewFor(report); await settle();
  assert.match(ui.textContent ?? '', /2 chart references/); assert.match(ui.textContent ?? '', /Affected dashboard/);
  assert.match(ui.textContent ?? '', /More chart references may exist/);
});
test('#7245 native dashboard Storage read refusal is unknown coverage instead of authoritative zero', async () => {
  const report = await realComparison();
  const read = localStorage.getItem;
  const refused = mock.method(localStorage, 'getItem', function(this: Storage, key: string) {
    if (key === 'ifc-lite-dashboards') throw new DOMException('Native dashboard storage blocked', 'SecurityError');
    return read.call(this, key);
  });
  try {
    const ui = previewFor(report); await settle();
    assert.match(ui.textContent ?? '', /More chart references may exist/);
    assert.equal(button(ui, 'Delete report')?.disabled, false);
  } finally { refused.mock.restore(); }
});
