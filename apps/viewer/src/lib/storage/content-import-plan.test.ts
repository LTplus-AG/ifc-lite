/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { refuseContentWrites } from '@/test/content-fixture.js';
import { beforeEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { createDocumentSlice } from '@/store/slices/documentSlice';
import { createValidationReportsSlice } from '@/store/slices/validationReportsSlice';
import { createSavedComparisonsSlice } from '@/store/slices/savedComparisonsSlice';
import { comparisonModels, comparisonResult } from '@/test/saved-comparison-fixture';
import { snapshotComparison } from '../compare/savedComparisons';
import { emptyManualReportBlock } from '../document/manual-report';
import { documentContent } from '../document/persistence';
import { blankDocument } from '../document/presets';
import type { DocumentSpec } from '../document/types';
import { newSavedReport, savedReportBlock } from '../validation/reports/history';
import { ContentImportFailure, createContentBackup, importContentBackup, retryContentImports, type ContentLibraries } from './content-backup';
import { contentTransaction, readContentRows, transactionDone, type ContentRow } from './content-database';
import { forgetContentImports, pendingContentImports } from './content-import-plan';

beforeEach(() => forgetContentImports(pendingContentImports()));

function libraries(name: string): ContentLibraries {
  const comparison = { ...snapshotComparison(comparisonResult('A', name === 'First' ? 'B' : 'C'), comparisonModels(), name), id: 'external-comparison' };
  const raw = newSavedReport({ ...emptyManualReportBlock('external-validation'), checklistName: name, generatedAt: '2026-01-01T00:00:00.000Z' }, name);
  const validation = { ...raw, id: 'external-validation', snapshot: { ...raw.snapshot, id: 'external-validation', savedReportId: 'external-validation' } };
  const document: DocumentSpec = { ...blankDocument(), id: 'external-document', name, blocks: [
    { kind: 'chart', id: 'chart-block', snapshot: true, chart: { id: 'chart', title: name, type: 'bar', source: 'compare', comparisonId: comparison.id, dimension: 'State', measure: { agg: 'count' } } },
    savedReportBlock(validation, 'report-block'),
  ] };
  return { document: [document], comparison: [comparison], validation: [validation] };
}
function visible(): ContentLibraries {
  const state = useViewerStore.getState();
  return { document: state.documents, comparison: state.savedComparisons, validation: state.savedValidationReports };
}
async function refused(backup: ReturnType<typeof createContentBackup>): Promise<ContentImportFailure> {
  try { await importContentBackup(backup, visible); }
  catch (error) { assert.ok(error instanceof ContentImportFailure); return error; }
  assert.fail('a refused native transaction must reject');
}
async function stage(entries: ContentLibraries): Promise<void> {
  await act(async () => {
    const state = useViewerStore.getState();
    for (const entry of entries.validation) state.stageValidationReport(entry);
    for (const entry of entries.comparison) state.stageComparison(entry);
    for (const entry of entries.document) state.stageDocument(entry);
  });
}
async function retry(): Promise<void> {
  await act(async () => {
    const state = useViewerStore.getState();
    assert.deepEqual(await Promise.all([state.retryDocumentsSave(), state.retrySaveComparisons(), state.retryValidationReportsSave()]), [true, true, true]);
    for (const pending of pendingContentImports()) {
      const row = (await readContentRows(pending.kind)).find(entry => entry.id === pending.id); assert.ok(row);
      assert.equal(row.importedFrom, pending.importedFrom, 'ordinary library retry atomically commits source identity with the content');
    }
    assert.equal(await retryContentImports(), true, 'the complete import is verified before success');
  });
}
async function reloadControllers(): Promise<void> {
  // Destroy session-only import identities and controller caches: only durable rows may deduplicate.
  forgetContentImports(pendingContentImports());
  await act(async () => {
    useViewerStore.setState({
      ...createDocumentSlice(useViewerStore.setState, useViewerStore.getState, useViewerStore),
      ...createValidationReportsSlice(useViewerStore.setState, useViewerStore.getState, useViewerStore),
      ...createSavedComparisonsSlice(useViewerStore.setState, useViewerStore.getState, useViewerStore),
    });
    const state = useViewerStore.getState();
    assert.deepEqual(await Promise.all([state.initializeDocuments(), state.initializeSavedComparisons(), state.initializeValidationReports()]), [true, true, true]);
  });
}
function assertBindings(entries: ContentLibraries, name: string): void {
  const document = entries.document.find(entry => entry.name === name); assert.ok(document);
  const chart = document.blocks[0], report = document.blocks[1];
  assert.ok(chart.kind === 'chart' && report.kind === 'manual-report');
  assert.equal(entries.comparison.find(entry => entry.id === chart.chart.comparisonId)?.name, name);
  assert.equal(entries.validation.find(entry => entry.id === report.savedReportId)?.name, name);
  assert.equal(report.checklistName, name, 'embedded evidence still belongs to its own source');
}

it('#6695 unreadable existing storage reserves independent IDs and later retry preserves unknown original rows', async () => {
  const first = libraries('First'), second = createContentBackup(libraries('Second'));
  assert.equal(await importContentBackup(createContentBackup(first)), 3);
  const blocked = mock.method(IDBDatabase.prototype, 'transaction', () => { throw new DOMException('Unreadable', 'SecurityError'); });
  let failure: ContentImportFailure;
  try { failure = await refused(second); }
  finally { blocked.mock.restore(); }
  for (const kind of ['document', 'comparison', 'validation'] as const) assert.notEqual(failure.entries[kind][0].id, first[kind][0].id);
  assertBindings(failure.entries, 'Second');
  await stage(failure.entries); await retry(); await reloadControllers();
  for (const kind of ['document', 'comparison', 'validation'] as const) {
    assert.equal(visible()[kind].length, 2);
    assert.deepEqual(visible()[kind].find(entry => entry.id === first[kind][0].id), first[kind][0], 'unknown durable neighbor is unchanged');
  }
  assertBindings(visible(), 'First'); assertBindings(visible(), 'Second');
});

it('#6695 distinct backups sharing external IDs retain independent evidence and reference their own imported sources', async () => {
  const first = createContentBackup(libraries('First')), second = createContentBackup(libraries('Second'));
  assert.equal(await importContentBackup(first), 3);
  assert.equal(await importContentBackup(second), 3);
  await reloadControllers();
  for (const kind of ['document', 'comparison', 'validation'] as const) assert.equal(visible()[kind].length, 2);
  assertBindings(visible(), 'First'); assertBindings(visible(), 'Second');
  assert.equal(await importContentBackup(second), 0, 'reimport cannot create an extra remapped source');
});

it('#6695 repeated refused import reuses IDs and durable fingerprint metadata deduplicates after retry and reload', async () => {
  assert.equal(await importContentBackup(createContentBackup(libraries('First'))), 3);
  const backup = createContentBackup(libraries('Second')), blocked = refuseContentWrites();
  let entries: ContentLibraries;
  try {
    const first = await refused(backup); entries = first.entries;
    await stage(entries);
    const again = await refused(backup);
    assert.deepEqual(again.entries, { document: [], validation: [], comparison: [] }, 'same refusal never restages or duplicates visible pending entries');
    assert.equal(pendingContentImports().length, 3);
  } finally { blocked.mock.restore(); }
  await retry();
  for (const kind of ['document', 'comparison', 'validation'] as const) {
    const row = (await readContentRows(kind)).find(value => value.id === entries[kind][0].id); assert.ok(row);
    assert.ok(row.importedFrom?.startsWith(`${kind}:`), 'retry durably preserves the canonical import fingerprint');
  }
  await reloadControllers();
  assert.equal(await importContentBackup(backup), 0);
  assertBindings(visible(), 'Second');
  for (const kind of ['document', 'comparison', 'validation'] as const) assert.equal(visible()[kind].length, 2);
});

it('#6695 deleted imported identities remain tombstoned when the same backup is imported after reload', async () => {
  const backup = createContentBackup(libraries('First'));
  assert.equal(await importContentBackup(backup), 3);
  await reloadControllers();
  const state = useViewerStore.getState();
  await act(async () => {
    assert.deepEqual(await Promise.all([state.deleteDocument('external-document'), state.deleteSavedComparison('external-comparison'), state.removeValidationReport('external-validation')]), [true, true, true]);
  });
  await reloadControllers();
  assert.equal(await importContentBackup(backup), 0, 'reimport cannot resurrect deliberately deleted evidence');
  for (const kind of ['document', 'comparison', 'validation'] as const) {
    const rows = await readContentRows(kind);
    assert.equal(rows.length, 1); assert.equal(rows[0].deleted, true); assert.ok(rows[0].importedFrom);
    assert.deepEqual(visible()[kind], []);
  }
});

it('#6695 ordinary document editing and individual library retries persist import identity without Retry all', async () => {
  assert.equal(await importContentBackup(createContentBackup(libraries('First'))), 3);
  const backup = createContentBackup(libraries('Second')), blocked = refuseContentWrites();
  let entries: ContentLibraries;
  try { entries = (await refused(backup)).entries; await stage(entries); }
  finally { blocked.mock.restore(); }
  await act(async () => {
    const state = useViewerStore.getState();
    assert.equal(await state.upsertDocument({ ...entries.document[0], name: 'Edited imported document' }), true);
    assert.equal(await state.retrySaveComparisons(), true);
    assert.equal(await state.retryValidationReportsSave(), true);
  });
  for (const kind of ['document', 'comparison', 'validation'] as const) {
    const row = (await readContentRows(kind)).find(value => value.id === entries[kind][0].id); assert.ok(row);
    assert.ok(row.importedFrom?.startsWith(`${kind}:`), 'each ordinary commit atomically stores its import fingerprint');
  }
  // Deliberately never call retryContentImports: independent save controls must suffice.
  await reloadControllers();
  assert.equal(await importContentBackup(backup), 0, 'a new session deduplicates without any session-only planner map');
  assert.equal(visible().document.find(entry => entry.id === entries.document[0].id)?.name, 'Edited imported document');
  for (const kind of ['document', 'comparison', 'validation'] as const) assert.equal(visible()[kind].length, 2);
});

it('#6695 a source collision discovered after refusal remaps pending document references without discarding author edits', async () => {
  const backup = createContentBackup(libraries('Second'));
  let blocked = refuseContentWrites(), first: ContentLibraries;
  try { first = (await refused(backup)).entries; await stage(first); }
  finally { blocked.mock.restore(); }
  await act(async () => useViewerStore.getState().stageDocument({ ...first.document[0], name: 'Edited pending document' }));
  const peer = libraries('First').comparison[0];
  // The peer has its own module state: bypass this tab's import sidecar with a native transaction.
  const tx = await contentTransaction('items', 'readwrite'), done = transactionDone(tx);
  tx.objectStore('items').add({ kind: 'comparison', id: peer.id, version: 1, revision: 1,
    createdAt: Date.now(), modifiedAt: Date.now(), deleted: false, payload: peer });
  await done;
  blocked = refuseContentWrites();
  let remapped: ContentLibraries;
  try { remapped = (await refused(backup)).entries; await stage(remapped); }
  finally { blocked.mock.restore(); }
  assert.equal(remapped.comparison.length, 1);
  assert.notEqual(remapped.comparison[0].id, peer.id, 'the import keeps an independent copy of its own comparison');
  const document = visible().document.find(entry => entry.name === 'Edited pending document'); assert.ok(document);
  const chart = document.blocks[0]; assert.equal(chart.kind, 'chart');
  if (chart.kind !== 'chart') assert.fail();
  assert.equal(chart.chart.comparisonId, remapped.comparison[0].id, 'the authored document follows the reallocated source instead of the other tab evidence');
});

async function acknowledge(receipts: readonly ContentRow[]): Promise<void> {
  await act(async () => {
    const state = useViewerStore.getState();
    assert.deepEqual(await Promise.all([state.refreshDocuments(receipts), state.refreshSavedComparisons(receipts), state.refreshValidationReports(receipts)]), [true, true, true]);
  });
}

it('#6695 a writable reimport acknowledges its exact committed draft and preserves authored changes', async () => {
  const backup = createContentBackup(libraries('Second')), blocked = refuseContentWrites();
  let entries: ContentLibraries;
  try { entries = (await refused(backup)).entries; await stage(entries); }
  finally { blocked.mock.restore(); }
  await act(async () => useViewerStore.getState().stageDocument({ ...entries.document[0], name: 'Authored pending document' }));
  let receipts: readonly ContentRow[] = [];
  assert.equal(await importContentBackup(backup, visible, true, rows => { receipts = rows; }), 3);
  assert.equal(receipts.length, 3);
  const persisted = (await readContentRows('document')).find(row => row.id === entries.document[0].id); assert.ok(persisted);
  assert.equal((persisted.payload as DocumentSpec).name, 'Authored pending document', 'atomic planning captures the author edit');
  await acknowledge(receipts);
  assert.equal(visible().document.find(entry => entry.id === entries.document[0].id)?.name, 'Authored pending document');
  for (const kind of ['document', 'comparison', 'validation'] as const) {
    const status = kind === 'document' ? useViewerStore.getState().documentsStorage
      : kind === 'comparison' ? useViewerStore.getState().savedComparisonsStorage : useViewerStore.getState().validationReportsStorage;
    assert.equal(status.items[entries[kind][0].id], 'saved', 'only the exact completed import acknowledges the staged draft');
  }
  const doc = visible().document[0], chart = doc.blocks[0], report = doc.blocks[1];
  assert.ok(chart.kind === 'chart' && report.kind === 'manual-report');
  assert.equal(chart.chart.comparisonId, visible().comparison[0].id);
  assert.equal(report.savedReportId, visible().validation[0].id);
  await reloadControllers();
  assert.equal(await importContentBackup(backup), 0);
  assert.equal(visible().document[0].name, 'Authored pending document');
});

it('#6695 an edit after the import transaction snapshot remains dirty and retries against its own committed revision', async () => {
  const backup = createContentBackup(libraries('Second')), blocked = refuseContentWrites();
  let entries: ContentLibraries;
  try { entries = (await refused(backup)).entries; await stage(entries); }
  finally { blocked.mock.restore(); }
  const original = IDBObjectStore.prototype.add;
  let edited = false, receipts: readonly ContentRow[] = [];
  const editDuringCommit = mock.method(IDBObjectStore.prototype, 'add', function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = original.call(this, value, key);
    if (this.name === 'items' && value && typeof value === 'object' && 'kind' in value && value.kind === 'document') {
      // The native request already holds the snapshot; this edit belongs to the later generation.
      useViewerStore.getState().stageDocument({ ...entries.document[0], name: 'Newer authored draft' });
      edited = true;
    }
    return request;
  });
  try {
    await act(async () => { assert.equal(await importContentBackup(backup, visible, true, rows => { receipts = rows; }), 3); });
  } finally { editDuringCommit.mock.restore(); }
  assert.equal(edited, true, 'edit occurs after the native import snapshot was queued');
  const committed = (await readContentRows('document'))[0];
  assert.equal((committed.payload as DocumentSpec).name, 'Second');
  await acknowledge(receipts);
  assert.equal(visible().document[0].name, 'Newer authored draft', 'receipt acknowledgment never clears a newer generation');
  const status = useViewerStore.getState().documentsStorage.items[entries.document[0].id];
  assert.notEqual(status, 'saved'); assert.notEqual(status, 'conflict', 'this tab knows its own committed revision');
  await act(async () => { assert.equal(await useViewerStore.getState().retryDocumentsSave(), true); });
  const retried = (await readContentRows('document'))[0];
  assert.equal(retried.revision, committed.revision + 1);
  assert.equal((retried.payload as DocumentSpec).name, 'Newer authored draft');
  assert.equal(useViewerStore.getState().documentsStorage.items[entries.document[0].id], 'saved');
});

it('#6695 writable reimport retains an unfinished authored image as invalid raw evidence while committing its valid prior snapshot', async () => {
  const backup = createContentBackup(libraries('Second')), blocked = refuseContentWrites();
  let entries: ContentLibraries;
  try { entries = (await refused(backup)).entries; await stage(entries); }
  finally { blocked.mock.restore(); }
  const unfinished: DocumentSpec = { ...entries.document[0], name: 'Unfinished authored evidence', blocks: [
    ...entries.document[0].blocks, { kind: 'image', id: 'unfinished-authored-image', dataUrl: '', height: 60, align: 'left' },
  ] };
  assert.equal(documentContent.decode(JSON.parse(JSON.stringify(unfinished))), null, 'portable JSON rejects the unfinished image');
  await act(async () => { assert.equal(await useViewerStore.getState().upsertDocument(unfinished), false); });
  assert.equal(useViewerStore.getState().documentsStorage.items[unfinished.id], 'invalid');
  // A peer claims the original source ID, so preserving the raw draft also requires remapping its binding.
  const peer = libraries('First').comparison[0];
  const tx = await contentTransaction('items', 'readwrite'), done = transactionDone(tx);
  tx.objectStore('items').add({ kind: 'comparison', id: peer.id, version: 1, revision: 1,
    createdAt: Date.now(), modifiedAt: Date.now(), deleted: false, payload: peer });
  await done;
  let receipts: readonly ContentRow[] = [];
  assert.equal(await importContentBackup(backup, visible, true, rows => { receipts = rows; }), 3);
  const committed = (await readContentRows('document'))[0], valid = documentContent.decode(committed.payload); assert.ok(valid);
  assert.equal(valid.name, 'Second'); assert.equal(valid.blocks.length, 2, 'the incomplete authored image never enters the durable library');
  await acknowledge(receipts);
  const current = visible().document.find(entry => entry.id === unfinished.id); assert.ok(current);
  assert.equal(current.name, unfinished.name);
  assert.deepEqual(current.blocks.at(-1), unfinished.blocks.at(-1), 'the incomplete image raw bytes remain editable/exportable');
  assert.equal(useViewerStore.getState().documentsStorage.items[unfinished.id], 'invalid', 'a committed prior snapshot cannot acknowledge the invalid newer draft');
  const storedChart = valid.blocks[0], currentChart = current.blocks[0];
  assert.ok(storedChart.kind === 'chart' && currentChart.kind === 'chart');
  assert.notEqual(storedChart.chart.comparisonId, peer.id);
  assert.equal(currentChart.chart.comparisonId, storedChart.chart.comparisonId, 'preserved raw evidence follows its own newly allocated source');
  const exported = createContentBackup(visible());
  assert.equal(exported.libraries.document.length, 0);
  assert.deepEqual(exported.drafts, [{ kind: 'document', id: current.id, raw: JSON.stringify(current) }]);
  assert.equal(await useViewerStore.getState().retryDocumentsSave(), false, 'retry cannot turn unfinished raw evidence into a valid saved claim');
});

it('#6695 a source remap in an own commit updates bindings on a newer author edit without undoing that edit', async () => {
  const backup = createContentBackup(libraries('Second')), blocked = refuseContentWrites();
  let entries: ContentLibraries;
  try { entries = (await refused(backup)).entries; await stage(entries); }
  finally { blocked.mock.restore(); }
  const peer = libraries('First').comparison[0];
  const tx = await contentTransaction('items', 'readwrite'), done = transactionDone(tx);
  tx.objectStore('items').add({ kind: 'comparison', id: peer.id, version: 1, revision: 1,
    createdAt: Date.now(), modifiedAt: Date.now(), deleted: false, payload: peer });
  await done;
  const original = IDBObjectStore.prototype.add;
  let receipts: readonly ContentRow[] = [], edited = false;
  const newerEdit = mock.method(IDBObjectStore.prototype, 'add', function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = original.call(this, value, key);
    if (this.name === 'items' && value && typeof value === 'object' && 'kind' in value && value.kind === 'document') {
      useViewerStore.getState().stageDocument({ ...entries.document[0], name: 'Newer author edit during source remap' });
      edited = true;
    }
    return request;
  });
  try {
    await act(async () => { assert.equal(await importContentBackup(backup, visible, true, rows => { receipts = rows; }), 3); });
  } finally { newerEdit.mock.restore(); }
  assert.equal(edited, true);
  const beforeRetry = (await readContentRows('document'))[0], committed = documentContent.decode(beforeRetry.payload); assert.ok(committed);
  await acknowledge(receipts);
  const current = visible().document.find(entry => entry.id === entries.document[0].id); assert.ok(current);
  assert.equal(current.name, 'Newer author edit during source remap');
  const chart = current.blocks[0], savedChart = committed.blocks[0]; assert.ok(chart.kind === 'chart' && savedChart.kind === 'chart');
  assert.notEqual(savedChart.chart.comparisonId, peer.id);
  assert.equal(chart.chart.comparisonId, savedChart.chart.comparisonId, 'a newer author edit keeps its own imported evidence binding');
  assert.notEqual(useViewerStore.getState().documentsStorage.items[current.id], 'saved');
  assert.notEqual(useViewerStore.getState().documentsStorage.items[current.id], 'conflict');
  await act(async () => { assert.equal(await useViewerStore.getState().retryDocumentsSave(), true); });
  const afterRetry = (await readContentRows('document'))[0];
  assert.equal(afterRetry.revision, beforeRetry.revision + 1);
  assert.deepEqual(afterRetry.payload, current, 'retry commits both the author edit and the correct source remap');
});
