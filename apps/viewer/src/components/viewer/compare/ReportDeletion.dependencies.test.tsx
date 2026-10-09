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
import { aggregate, type ChartSpec } from '@ifc-lite/charts';
import { CLASH_COLUMNS } from '@/lib/charts/datasets/clash';
import { COMPARE_COLUMNS } from '@/lib/charts/datasets/compare';
import { chartSourceContext, resolveChartSource } from '@/lib/charts/chart-source';
import { buildEntityFingerprints } from '@/lib/compare/buildFingerprints';
import { snapshotComparison } from '@/lib/compare/savedComparisons';
import { blankDocument } from '@/lib/document/presets';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { click, render, cleanup, waitFor } from '@/test/render';
import { detectCoincidentWalls, mountClashPanel, saveCurrentResultAs } from '@/test/clash-report-fixture';
import { readContentRows, writeContent, writeContentBatch } from '@/lib/storage/content-database';
import { reportChartDependencies } from '@/lib/reports/chart-dependencies';
import { createDocumentSlice } from '@/store/slices/documentSlice';
import { ReportDeletionPreview } from '../ReportDeletionPreview';
import { Toaster } from '@/components/ui/toast';
import { latestToast } from '@/test/toasts';
import { SavedComparisonLibrary } from './SavedComparisonLibrary';

const original = useViewerStore.getState();
const button = (root: ParentNode, name: string) => [...root.querySelectorAll('button')].find(node => node.textContent?.trim() === name);
beforeEach(async () => { localStorage.clear(); await clearContentDatabase(); useViewerStore.setState({ dashboards: [], documents: [] }); });
afterEach(() => { cleanup(); useViewerStore.setState(original); localStorage.clear(); });
async function dependents(source: 'compare' | 'clash', id: string) {
  const spec: ChartSpec = { id: 'dependent-chart', title: 'External report chart', source, type: 'bar', dimension: source === 'compare' ? COMPARE_COLUMNS.state : CLASH_COLUMNS.rule, measure: { agg: 'count' },
    ...(source === 'compare' ? { comparisonId: id } : { clashReportId: id }) };
  const bound = resolveChartSource(spec, { source, columns: [], rows: [], fingerprint: 'empty-live-control' }, chartSourceContext(useViewerStore.getState()));
  assert.ok(aggregate(spec, bound.dataset).total > 0, 'the native saved-report chart must actually aggregate before it becomes a deletion dependency');
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
test('#7245 recovered Document originals disclose incomplete coverage beside their readable chart references', async () => {
  const report = await realComparison();
  const spec: ChartSpec = { id: 'recovered-chart', title: 'Recovered readable chart', source: 'compare', comparisonId: report.id, type: 'bar', dimension: 'State', measure: { agg: 'count' } };
  const document = { ...blankDocument(), name: 'Recovered readable Document', blocks: [{ kind: 'chart' as const, id: 'recovered-block', chart: spec, snapshot: true }] };
  localStorage.setItem('ifc-lite-documents', JSON.stringify([document, null]));
  useViewerStore.setState(createDocumentSlice(useViewerStore.setState, useViewerStore.getState, useViewerStore));
  const ui = previewFor(report);
  await waitFor(() => useViewerStore.getState().documentsStorage.phase === 'ready', 'native migration retains the readable Document');
  await settle();
  assert.equal(useViewerStore.getState().documentsStorage.recovered, true);
  assert.match(ui.textContent ?? '', /Recovered readable Document/);
  assert.match(ui.textContent ?? '', /More chart references may exist/);
});
test('#7245 references changed after confirmation but before native queued commit revoke deletion', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const ui = previewFor(report); await settle();
  const dashboard = useViewerStore.getState().dashboards[0];
  click(button(ui, 'Delete report')!);
  // Native deletion has staged its tombstone, but the queued persistence promise has not committed.
  act(() => useViewerStore.getState().upsertDashboard({ ...dashboard, charts: [...dashboard.charts,
    { ...dashboard.charts[0], id: 'later-dependent-chart', title: 'New dependency after confirmation' }] }));
  await waitFor(() => useViewerStore.getState().savedComparisonsStorage.items[report.id] !== 'saving', 'queued native deletion finishes or refuses');
  const saved = (await readContentRows('comparison')).find(row => row.id === report.id); assert.ok(saved);
  assert.equal(saved.deleted, false, 'old confirmation must not delete after its dependency set changed');
  assert.ok(useViewerStore.getState().savedComparisons.some(row => row.id === report.id));
});
test('#7245 a refused quota tombstone rechecks changed dependencies on native Retry and restores its source', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const ui = previewFor(report); await settle();
  const refused = refuseContentWrites();
  try {
    click(button(ui, 'Delete report')!);
    await waitFor(() => useViewerStore.getState().savedComparisonsStorage.items[report.id] === 'quota', 'native guarded deletion refuses quota');
  } finally { refused.mock.restore(); }
  const dashboard = useViewerStore.getState().dashboards[0];
  act(() => useViewerStore.getState().upsertDashboard({ ...dashboard, name: 'Dependency revised before Retry' }));
  assert.equal(await useViewerStore.getState().retrySaveComparisons(), false);
  assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false);
  assert.ok(useViewerStore.getState().savedComparisons.some(row => row.id === report.id), 'refused old deletion restores its readable source');
});
test('#7245 revoked queued deletion preserves a newer native same-ID rename draft', async () => {
  const report = await realComparison(); const ui = previewFor(report); await settle();
  click(button(ui, 'Delete report')!);
  let renamed: Promise<boolean> = Promise.resolve(false);
  act(() => { renamed = useViewerStore.getState().renameSavedComparison(report.id, 'Newer native rename draft'); });
  await renamed;
  assert.equal(useViewerStore.getState().savedComparisons.find(row => row.id === report.id)?.name, 'Newer native rename draft');
  assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false);
  assert.equal(await useViewerStore.getState().retrySaveComparisons(), true);
  const durable = (await readContentRows('comparison')).find(row => row.id === report.id); assert.ok(durable && !durable.deleted);
  assert.equal((durable.payload as { name: string }).name, 'Newer native rename draft');
});
test('#7245 native preview unmount revokes a queued confirmation before its actual storage write', async () => {
  const report = await realComparison(); const ui = previewFor(report); await settle();
  click(button(ui, 'Delete report')!); cleanup();
  await waitFor(() => useViewerStore.getState().savedComparisonsStorage.items[report.id] !== 'saving', 'native queued deletion observes lost preview owner');
  assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false);
  assert.ok(useViewerStore.getState().savedComparisons.some(row => row.id === report.id));
});

test('#7245 revoked native confirmation explains changed references without reporting a fictitious storage outage', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const ui = render(<><SavedComparisonLibrary result={null} running={false} /><Toaster /></>);
  const picker = ui.querySelector('select'); assert.ok(picker);
  act(() => { picker.value = report.id; picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
  click(button(ui, 'Delete saved comparison')!); await settle();
  const dashboard = useViewerStore.getState().dashboards[0];
  click(button(ui, 'Delete report')!);
  act(() => useViewerStore.getState().upsertDashboard({ ...dashboard, name: 'Changed just before native write' }));
  await waitFor(() => useViewerStore.getState().savedComparisonsStorage.items[report.id] !== 'saving', 'revoked native request finishes');
  await settle();
  assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false);
  assert.match(ui.textContent ?? '', /Chart references changed/);
  assert.doesNotMatch(latestToast(ui), /Comparison changes are in memory, but browser storage is unavailable or full/);
});

test('#7245 closing a quota-refused native preview revokes its retained deletion on Retry', async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const ui = previewFor(report); await settle();
  const refused = refuseContentWrites();
  try {
    click(button(ui, 'Delete report')!);
    await waitFor(() => useViewerStore.getState().savedComparisonsStorage.items[report.id] === 'quota', 'native deletion actually stages a refused quota tombstone');
    assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false, 'durable native source survives actual quota refusal');
  } finally { refused.mock.restore(); }
  cleanup();
  assert.equal(await useViewerStore.getState().retrySaveComparisons(), false, 'closed review cannot authorize a later native storage retry');
  assert.equal((await readContentRows('comparison')).find(row => row.id === report.id)?.deleted, false);
  assert.ok(useViewerStore.getState().savedComparisons.some(row => row.id === report.id), 'revocation restores the original readable native source');
});

for (const addReference of [false, true]) test(`#7245 own import receipt ${addReference ? 'cannot reuse approval after a new native chart reference' : 'retains approved native CAS retry'}`, async () => {
  const report = await realComparison(); await dependents('compare', report.id);
  const state = useViewerStore.getState();
  const source = { kind: 'compare' as const, id: report.id };
  const approved = reportChartDependencies(state, source).signature;
  const row = (await readContentRows('comparison')).find(entry => entry.id === report.id)!;
  let checks = 0;
  let ownCommit: Promise<void> | undefined;
  const stillApproved = () => reportChartDependencies(useViewerStore.getState(), source).signature === approved;
  const guard = () => {
    checks++;
    if (!stillApproved()) return false;
    if (!ownCommit) {
      // A real own commit is queued before the pending deletion transaction.
      // Its receipt advances the native controller's CAS revision, not a mock.
      ownCommit = writeContentBatch([{ kind: 'comparison', id: report.id, payload: report, expected: row.revision }]).then(async result => {
        assert.equal(result.ok, true);
        if (!result.ok) throw new Error('Actual own comparison commit refused');
        assert.equal(result.rows[0].revision, row.revision + 1, 'the receipt acknowledges an actual native committed revision');
        if (addReference) {
          const dashboard = useViewerStore.getState().dashboards[0];
          useViewerStore.getState().upsertDashboard({ ...dashboard, charts: [...dashboard.charts, { ...dashboard.charts[0], id: 'new-native-reference', title: 'Reference added during CAS' }] });
        }
        await useViewerStore.getState().refreshSavedComparisons(result.rows);
      });
    }
    return true;
  };
  const deleted = await state.deleteSavedComparison(report.id, guard);
  await ownCommit;
  assert.equal(stillApproved(), !addReference, 'native chart reference change is independently verified');
  assert.equal(deleted, !addReference, 'the second actual CAS write preserves current deletion authority');
  if (addReference) assert.ok(checks >= 2, 'the optional native guard is consulted again before retrying the write');
  assert.equal((await readContentRows('comparison')).find(entry => entry.id === report.id)?.deleted, !addReference);
  if (addReference) {
    assert.ok(useViewerStore.getState().savedComparisons.some(entry => entry.id === report.id), 'revocation restores the native readable source');
    const chart = useViewerStore.getState().dashboards[0].charts.find(entry => entry.id === 'new-native-reference')!;
    const bound = resolveChartSource(chart, { source: 'compare', columns: [], rows: [], fingerprint: 'empty-live-control' }, chartSourceContext(useViewerStore.getState()));
    assert.ok(aggregate(chart, bound.dataset).total > 0, 'the new native dependent still reads its saved comparison');
  }
});
