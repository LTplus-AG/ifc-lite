/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import { refuseContentWrites } from '@/test/content-fixture.js';
import { it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { render, cleanup, click, waitFor } from '@/test/render';
import { blankDocument } from '@/lib/document/presets';
import { loadDocuments } from '@/lib/document/persistence';
import { createContentBackup, parseContentBackup, readBackupDrafts, readContentRecovery } from '@/lib/storage/content-backup';
import '@/test/download-capture';
import { Toaster } from '@/components/ui/toast';
import { ContentStorageNotice } from './ContentStorageNotice';

afterEach(cleanup);
function Notice() {
  const status = useViewerStore(state => state.documentsStorage);
  return <ContentStorageNotice status={status} retry={() => useViewerStore.getState().retryDocumentsSave()}
    restore={() => useViewerStore.getState().restoreDocuments()} />;
}

it('#6679 a refused backup import stages an independent exportable draft and Retry save commits that same copy', async () => {
  const entry = { ...blankDocument(), name: 'Existing saved document' };
  assert.equal(await useViewerStore.getState().upsertDocument(entry), true);
  const ui = render(<><Notice /><Toaster /></>);
  const input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  const backup = createContentBackup({ document: [{ ...entry, name: 'Imported draft' }], validation: [], comparison: [] });
  const file = new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  const refused = refuseContentWrites();
  try {
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => useViewerStore.getState().documents.some(document => document.name === 'Imported draft'), 'refused import stages its draft');
    const state = useViewerStore.getState();
    assert.equal(state.documents.length, 2);
    assert.notEqual(state.documents[1].id, entry.id);
    assert.equal(state.documentsStorage.items[state.documents[1].id], 'unavailable');
    assert.deepEqual((await loadDocuments()).map(document => document.name), [entry.name]);
  } finally { refused.mock.restore(); }
  const id = useViewerStore.getState().documents[1].id;
  const retry = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Retry save'); assert.ok(retry);
  click(retry);
  await waitFor(() => useViewerStore.getState().documentsStorage.items[id] === 'saved', 'retry commits the same imported draft');
  assert.deepEqual((await loadDocuments()).map(document => document.id), [entry.id, id]);
});

it('#6695 repeated real quota refusal reuses one draft and preserves edits through individual retry', async () => {
  const entry = { ...blankDocument(), name: 'Imported once' }, ui = render(<><Notice /><Toaster /></>);
  const input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  const file = new File([JSON.stringify(createContentBackup({ document: [entry], validation: [], comparison: [] }))], 'same.json');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  const refused = refuseContentWrites();
  const importAgain = async () => {
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => [...ui.querySelectorAll('button')].every(button => !button.disabled), 'import transaction settles');
  };
  let id: string;
  try {
    await importAgain();
    assert.equal(useViewerStore.getState().documents.length, 1);
    id = useViewerStore.getState().documents[0].id;
    await act(async () => useViewerStore.getState().stageDocument({ ...entry, id, name: 'My newer edit' }));
    await importAgain();
    assert.equal(useViewerStore.getState().documents.length, 1, 'same File cannot create a second draft');
    assert.equal(useViewerStore.getState().documents[0].name, 'My newer edit');
    assert.equal(useViewerStore.getState().documentsStorage.items[id], 'unavailable');
    assert.deepEqual(await loadDocuments(), []);
  } finally { refused.mock.restore(); }
  const retry = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Retry save'); assert.ok(retry);
  click(retry);
  await waitFor(() => useViewerStore.getState().documentsStorage.items[id] === 'saved', 'individual retry commits preserved edit');
  assert.equal((await loadDocuments())[0].name, 'My newer edit');
  await importAgain();
  assert.equal(useViewerStore.getState().documents.length, 1, 'same import after saving stays deduplicated');
  assert.equal(useViewerStore.getState().documents[0].name, 'My newer edit');
});

it('#6695 a postcommit refresh failure reports saved evidence without staging a duplicate draft', async () => {
  const entry = blankDocument(), ui = render(<><Notice /><Toaster /></>);
  const input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(createContentBackup({ document: [entry], validation: [], comparison: [] }))], 'saved.json')], configurable: true });
  const original = IDBDatabase.prototype.transaction;
  let committed = false;
  const unavailable = mock.method(IDBDatabase.prototype, 'transaction', function (this: IDBDatabase,
    stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
    const items = stores === 'items' || Array.isArray(stores) && stores.includes('items');
    if (items && mode === 'readonly' && committed) throw new DOMException('Read unavailable after commit', 'SecurityError');
    const transaction = original.call(this, stores, mode, options);
    if (items && mode === 'readwrite') transaction.addEventListener('complete', () => { committed = true; });
    return transaction;
  });
  try {
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => document.body.textContent?.includes('The import was saved') ?? false, 'refresh warning distinguishes a successful durable commit');
    assert.deepEqual(useViewerStore.getState().documents, [], 'failed refresh never stages an already committed copy');
    assert.equal(Object.values(useViewerStore.getState().documentsStorage.items).includes('unavailable'), false);
  } finally { unavailable.mock.restore(); }
  assert.deepEqual(await loadDocuments(), [entry], 'the actual transaction committed before native reads failed');
  await act(async () => useViewerStore.getState().initializeDocuments());
  assert.deepEqual(useViewerStore.getState().documents, [entry]);
});

it('#6679 invalid backup input changes neither memory nor committed content', async () => {
  const entry = blankDocument(); await useViewerStore.getState().upsertDocument(entry);
  const ui = render(<><Notice /><Toaster /></>);
  const input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  const backup = createContentBackup({ document: [entry], validation: [], comparison: [] });
  const raw = { ...backup, libraries: { ...backup.libraries, document: [entry, null] } };
  Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(raw)], 'invalid.json')], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await waitFor(() => document.body.textContent?.includes('Invalid document entry') ?? false, 'invalid backup is rejected before mutation');
  assert.deepEqual(useViewerStore.getState().documents, [entry]);
  assert.deepEqual(await loadDocuments(), [entry]);
});

it('#6679 Retry all libraries remaps conflicting linked sources from a refused multi-library import', async () => {
  const { comparisonModels, comparisonResult } = await import('@/test/saved-comparison-fixture');
  const { snapshotComparison } = await import('@/lib/compare/savedComparisons');
  const { loadSavedComparisons } = await import('@/lib/compare/savedComparisonPersistence');
  const { newSavedReport, savedReportBlock } = await import('@/lib/validation/reports/history');
  const { loadValidationReports } = await import('@/lib/validation/reports/persistence');
  const { emptyManualReportBlock } = await import('@/lib/document/manual-report');
  const comparison = snapshotComparison(comparisonResult('A', 'B'), comparisonModels(), 'Imported comparison');
  const report = newSavedReport(emptyManualReportBlock('manual'), 'Imported validation');
  const document = { ...blankDocument(), blocks: [
    { kind: 'chart' as const, id: 'chart-block', snapshot: true, chart: { id: 'chart', title: 'Linked report', source: 'compare' as const,
      type: 'bar' as const, comparisonId: comparison.id, dimension: 'State', measure: { agg: 'count' as const } } },
    savedReportBlock(report, 'manual-block'),
  ] };
  const state = useViewerStore.getState();
  assert.equal(await state.saveComparison({ ...comparison, name: 'Existing comparison' }), true);
  assert.equal(await state.saveValidationReportEntry({ ...report, name: 'Existing validation' }), report.id);
  const preservedComparisons = await loadSavedComparisons(), preservedReports = await loadValidationReports();
  const backup = createContentBackup({ document: [document], comparison: [comparison], validation: [report] });
  const ui = render(<Notice />), input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(backup)], 'linked.json')], configurable: true });
  const refused = refuseContentWrites();
  try {
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => useViewerStore.getState().documents.length === 1, 'all imported drafts are staged');
    assert.equal(useViewerStore.getState().savedComparisons.length, 2);
    assert.equal(useViewerStore.getState().savedValidationReports.length, 2);
    assert.deepEqual(await loadSavedComparisons(), preservedComparisons);
    assert.deepEqual(await loadValidationReports(), preservedReports);
  } finally { refused.mock.restore(); }
  const retry = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Retry all libraries'); assert.ok(retry);
  click(retry);
  await waitFor(() => {
    const state = useViewerStore.getState();
    return [state.documentsStorage, state.validationReportsStorage, state.savedComparisonsStorage]
      .every(status => Object.values(status.items).every(value => value === 'saved'));
  }, 'all linked sources and the document commit');
  const [stored] = await loadDocuments(), comparisons = await loadSavedComparisons(), reports = await loadValidationReports();
  const storedComparison = comparisons.find(entry => entry.name === comparison.name);
  const storedReport = reports.find(entry => entry.name === report.name);
  assert.ok(storedComparison && storedReport);
  assert.deepEqual(comparisons.filter(entry => entry.id === comparison.id), preservedComparisons);
  assert.deepEqual(reports.filter(entry => entry.id === report.id), preservedReports);
  assert.ok(stored.blocks[0].kind === 'chart' && stored.blocks[1].kind === 'manual-report');
  assert.notEqual(storedComparison.id, comparison.id, 'the conflicting original must survive beside its independent copy');
  assert.notEqual(storedReport.id, report.id);
  assert.equal(stored.blocks[0].chart.comparisonId, storedComparison.id);
  assert.equal(stored.blocks[1].savedReportId, storedReport.id);
});


it('#6679 whole-library export waits for every library and remains usable when storage is unavailable', async () => {
  const state = useViewerStore.getState();
  useViewerStore.setState({ savedComparisonsStorage: { ...state.savedComparisonsStorage, phase: 'loading' } });
  const ui = render(<Notice />);
  const button = [...ui.querySelectorAll('button')].find(value => value.textContent === 'Download library backup');
  assert.ok(button);
  assert.equal(button.disabled, true);
  await act(async () => { useViewerStore.setState({ savedComparisonsStorage: { ...state.savedComparisonsStorage, phase: 'unavailable' } }); });
  assert.equal(button.disabled, false);
});

it('#6695 library downloads and preserved originals recover an imported unfinished image beside valid content', async () => {
  const entry = blankDocument(), incomplete = { ...blankDocument(), blocks: [
    { kind: 'image' as const, id: 'unfinished-image', dataUrl: '', height: 60, align: 'left' as const },
  ] };
  const backup = createContentBackup({ document: [entry, incomplete], validation: [], comparison: [] });
  const ui = render(<><Notice /><Toaster /></>), input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(backup)], 'unfinished.json')], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await waitFor(() => document.body.textContent?.includes('Preserved 1 incomplete draft as raw recovery evidence') ?? false,
    'successful import explains where the unfinished draft can be recovered');
  assert.deepEqual(await loadDocuments(), [entry]);
  const downloads: Blob[] = [];
  const urls = mock.method(URL, 'createObjectURL', (blob: Blob | MediaSource) => {
    assert.ok(blob instanceof Blob); downloads.push(blob); return `blob:recovery-${downloads.length}`;
  });
  try {
    const find = (text: string) => { const button = [...ui.querySelectorAll('button')].find(value => value.textContent === text); assert.ok(button); return button; };
    click(find('Download library backup'));
    await waitFor(() => downloads.length === 1, 'a further library backup downloads');
    const exported = parseContentBackup(await downloads[0].text());
    assert.deepEqual(exported.libraries.document, [entry]);
    assert.deepEqual(exported.drafts, backup.drafts);
    click(find('Download preserved originals'));
    await waitFor(() => downloads.length === 2, 'raw draft originals download');
    const rows = JSON.parse(await downloads[1].text()) as Array<{ raw: string }>;
    assert.deepEqual(rows.map(row => JSON.parse(row.raw)), backup.drafts);
    assert.equal((JSON.parse(rows[0].raw) as { raw: string }).raw, JSON.stringify(incomplete));
  } finally { urls.mock.restore(); }
});

it('#6695 a refused raw-draft import stays downloadable during unreadable storage and Retry all archives it', async () => {
  const entry = blankDocument(), incomplete = { ...blankDocument(), blocks: [
    { kind: 'image' as const, id: 'session-image', dataUrl: '', height: 60, align: 'left' as const },
  ] };
  const backup = createContentBackup({ document: [entry, incomplete], validation: [], comparison: [] });
  const ui = render(<><Notice /><Toaster /></>), input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(backup)], 'blocked.json')], configurable: true });
  const refused = mock.method(IDBDatabase.prototype, 'transaction', () => { throw new DOMException('Unavailable', 'SecurityError'); });
  const downloads: Blob[] = [];
  const urls = mock.method(URL, 'createObjectURL', (blob: Blob | MediaSource) => {
    assert.ok(blob instanceof Blob); downloads.push(blob); return `blob:session-${downloads.length}`;
  });
  try {
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => document.body.textContent?.includes('1 incomplete draft remains only in this tab') ?? false,
      'refused import reports that raw evidence is only in memory');
    const button = [...ui.querySelectorAll('button')].find(value => value.textContent === 'Download library backup'); assert.ok(button);
    click(button);
    await waitFor(() => downloads.length === 1, 'backup still downloads when archived evidence cannot be read');
    const exported = parseContentBackup(await downloads[0].text());
    assert.equal(exported.libraries.document.length, 1);
    assert.deepEqual(exported.drafts, backup.drafts);
    await waitFor(() => document.body.textContent?.includes('Archived draft evidence could not be read') ?? false,
      'download warns that unavailable archives were not included');
  } finally { urls.mock.restore(); refused.mock.restore(); }
  const retry = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Retry all libraries'); assert.ok(retry);
  click(retry);
  await waitFor(() => [...ui.querySelectorAll('button')].every(button => !button.disabled), 'retry finishes');
  assert.deepEqual((await readBackupDrafts()).drafts, backup.drafts);
  const originals = (await readContentRecovery()).filter(row => row.key.startsWith('backup-draft:'));
  assert.equal(originals.length, 1);
  assert.ok(!originals[0].key.includes('session:'), 'Retry all commits raw evidence into IndexedDB');
  assert.equal((await loadDocuments()).length, 1);
  assert.equal(await useViewerStore.getState().retryDocumentsSave(), true);
});
