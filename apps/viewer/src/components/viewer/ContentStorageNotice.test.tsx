/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { refuseContentWrites } from '@/test/content-fixture.js';
import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { render, cleanup, click, waitFor } from '@/test/render';
import { blankDocument } from '@/lib/document/presets';
import { loadDocuments } from '@/lib/document/persistence';
import { createContentBackup } from '@/lib/storage/content-backup';
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

it('#6679 Retry all libraries retains every linked source from a refused multi-library import', async () => {
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
  const backup = createContentBackup({ document: [document], comparison: [comparison], validation: [report] });
  const ui = render(<Notice />), input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(backup)], 'linked.json')], configurable: true });
  const refused = refuseContentWrites();
  try {
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => useViewerStore.getState().documents.length === 1, 'all imported drafts are staged');
    assert.equal(useViewerStore.getState().savedComparisons.length, 1);
    assert.equal(useViewerStore.getState().savedValidationReports.length, 1);
    assert.deepEqual(await loadSavedComparisons(), []);
    assert.deepEqual(await loadValidationReports(), []);
  } finally { refused.mock.restore(); }
  const retry = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Retry all libraries'); assert.ok(retry);
  click(retry);
  await waitFor(() => {
    const state = useViewerStore.getState();
    return [state.documentsStorage, state.validationReportsStorage, state.savedComparisonsStorage]
      .every(status => Object.values(status.items).every(value => value === 'saved'));
  }, 'all linked sources and the document commit');
  const [stored] = await loadDocuments(), [storedComparison] = await loadSavedComparisons(), [storedReport] = await loadValidationReports();
  assert.ok(stored.blocks[0].kind === 'chart' && stored.blocks[1].kind === 'manual-report');
  assert.notEqual(storedComparison.id, comparison.id);
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
