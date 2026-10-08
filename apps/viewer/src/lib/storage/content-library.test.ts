/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import { clearContentDatabase, refuseContentWrites } from '@/test/content-fixture.js';
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { blankDocument } from '../document/presets';
import { documentContent, loadDocuments } from '../document/persistence';
import type { DocumentSpec } from '../document/types';
import { createContentLibrary, initialContentStatus } from './content-library';
import { contentTransaction, readContentRows, requestValue, transactionDone, writeContent } from './content-database';
import { migrateContent } from './content-migration';
import { createContentBackup, parseContentBackup, importContentBackup, readBackupDrafts, readContentRecovery, cleanupContentLegacy, preserveLegacyChange } from './content-backup';

function documents() {
  let entries: DocumentSpec[] = [];
  let status = initialContentStatus();
  const library = createContentLibrary(documentContent, () => entries, (next, state) => { entries = next; status = state; });
  return { ...library, entries: () => entries, status: () => status };
}

it('#6679 retains a library larger than localStorage even when legacy writes are refused', async () => {
  const library = documents();
  await library.initialize();
  const refused = mock.method(localStorage, 'setItem', () => { throw new DOMException('Full', 'QuotaExceededError'); });
  const entries = Array.from({ length: 8 }, (_, index) => ({ ...blankDocument(), name: `Report ${index}`,
    blocks: [{ kind: 'text' as const, id: 'body', style: 'body' as const, text: 'Measured evidence '.repeat(50_000) }] }));
  try {
    assert.ok(new Blob([JSON.stringify(entries)]).size > 5 * 1024 * 1024);
    assert.ok((await Promise.all(entries.map(entry => library.put(entry.id, entry)))).every(Boolean));
    const reopened = await loadDocuments();
    assert.deepEqual(reopened.map(entry => entry.name), entries.map(entry => entry.name));
    assert.deepEqual(reopened.map(entry => entry.blocks), entries.map(entry => entry.blocks));
  } finally { refused.mock.restore(); }
});

it('#6679 serializes rapid edits without letting an older completion clear a newer draft', async () => {
  const library = documents();
  const entry = blankDocument();
  const first = library.put(entry.id, { ...entry, name: 'First' });
  const second = library.put(entry.id, { ...entry, name: 'Second' });
  const third = library.put(entry.id, { ...entry, name: 'Final' });
  assert.equal(library.entries()[0].name, 'Final');
  assert.equal(library.status().items[entry.id], 'saving');
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  assert.equal((await loadDocuments())[0].name, 'Final');
  assert.equal(library.status().items[entry.id], 'saved');
});

it('#6679 preserves unsaved edits and retries the same ID after a refused transaction', async () => {
  const library = documents(); await library.initialize();
  const entry = blankDocument();
  const refused = refuseContentWrites();
  try {
    assert.equal(await library.put(entry.id, entry), false);
    assert.equal(library.status().items[entry.id], 'quota');
    assert.equal(library.entries()[0].id, entry.id);
    assert.deepEqual(await loadDocuments(), []);
  } finally { refused.mock.restore(); }
  assert.equal(await library.retry(), true);
  assert.deepEqual((await loadDocuments()).map(value => value.id), [entry.id]);
});

it('#6679 a transaction aborted after put never claims success or modifies the saved document', async () => {
  const library = documents(); const entry = blankDocument();
  assert.equal(await library.put(entry.id, entry), true);
  const original = IDBObjectStore.prototype.put;
  const aborted = mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = original.call(this, value, key);
    if (this.name === 'items') this.transaction.abort();
    return request;
  });
  try {
    assert.equal(await library.put(entry.id, { ...entry, name: 'Uncommitted' }), false);
    assert.equal(library.entries()[0].name, 'Uncommitted');
    assert.equal((await loadDocuments())[0].name, entry.name);
  } finally { aborted.mock.restore(); }
  assert.equal(await library.retry(), true);
  assert.equal((await loadDocuments())[0].name, 'Uncommitted');
});

it('#6679 two tabs cannot overwrite each other or resurrect deleted documents', async () => {
  const first = documents(); const entry = blankDocument();
  await first.put(entry.id, entry);
  const second = documents(); await second.initialize();
  await first.put(entry.id, { ...entry, name: 'First tab' });
  assert.equal(await second.put(entry.id, { ...entry, name: 'Second tab draft' }), false);
  assert.equal(second.status().items[entry.id], 'conflict');
  await second.refresh();
  assert.equal(second.entries()[0].name, 'Second tab draft');
  assert.equal(await second.retry(), false);
  assert.equal((await loadDocuments())[0].name, 'First tab');
  await first.put(entry.id, null);
  assert.equal(await second.retry(), false);
  assert.deepEqual(await loadDocuments(), []);
  const tombstone = (await readContentRows('document'))[0];
  assert.equal(tombstone.deleted, true);
  assert.deepEqual(await writeContent('document', entry.id, entry, tombstone.revision), { ok: false, reason: 'conflict' });
});

it('#6679 incomplete initial reads preserve unknown neighbours and pending edits on retry', async () => {
  await clearContentDatabase();
  const older = { ...blankDocument(), name: 'Older saved document' };
  localStorage.setItem(documentContent.legacyKey, JSON.stringify([older]));
  const library = documents();
  const pending = { ...blankDocument(), name: 'Pending document' };
  const actual = localStorage.getItem.bind(localStorage);
  const blocked = mock.method(localStorage, 'getItem', (key: string) => {
    if (key === documentContent.legacyKey) throw new DOMException('Blocked read', 'SecurityError');
    return actual(key);
  });
  try { assert.equal(await library.put(pending.id, pending), false); }
  finally { blocked.mock.restore(); }
  assert.equal(await library.retry(), true);
  assert.deepEqual((await loadDocuments()).map(entry => entry.name), [older.name, pending.name]);
  assert.equal(await library.put(older.id, null), true);
  await library.retry();
  assert.deepEqual((await loadDocuments()).map(entry => entry.name), [pending.name]);
});

it('#6679 migration preserves partial originals, IDs and ordering and does not replay after deletion', async () => {
  await clearContentDatabase();
  const first = blankDocument(), second = blankDocument();
  const raw = JSON.stringify([first, null, second, first]);
  localStorage.setItem(documentContent.legacyKey, raw);
  assert.equal(await migrateContent(documentContent), true);
  assert.deepEqual((await loadDocuments()).map(entry => entry.id), [first.id, second.id]);
  assert.equal((await readContentRecovery())[0].raw, raw);
  const library = documents(); await library.initialize();
  await library.put(first.id, null);
  await migrateContent(documentContent);
  assert.deepEqual((await loadDocuments()).map(entry => entry.id), [second.id]);
  assert.equal(localStorage.getItem(documentContent.legacyKey), raw);
  await cleanupContentLegacy();
  assert.equal(localStorage.getItem(documentContent.legacyKey), null);
  assert.equal((await readContentRecovery())[0].raw, raw);
});

it('#6679 failed migration commits neither neighbours nor a marker and can resume intact', async () => {
  await clearContentDatabase();
  const entry = blankDocument(), raw = JSON.stringify([entry]);
  localStorage.setItem(documentContent.legacyKey, raw);
  const original = IDBObjectStore.prototype.put;
  const interrupted = mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = original.call(this, value, key);
    if (this.name === 'migrations') this.transaction.abort();
    return request;
  });
  try { await assert.rejects(migrateContent(documentContent)); }
  finally { interrupted.mock.restore(); }
  assert.deepEqual(await readContentRows('document'), []);
  assert.equal(localStorage.getItem(documentContent.legacyKey), raw);
  await migrateContent(documentContent);
  assert.deepEqual((await loadDocuments()).map(value => value.id), [entry.id]);
});

it('#6679 portable backups preserve image bytes and drafts, retaining conflicts as independent copies', async () => {
  const library = documents();
  const entry = { ...blankDocument(), blocks: [{ kind: 'image' as const, id: 'logo',
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=', height: 60, align: 'left' as const }] };
  await library.put(entry.id, entry);
  const draft = { ...entry, name: 'My draft' };
  const backup = parseContentBackup(JSON.stringify(createContentBackup({ document: [draft], validation: [], comparison: [] })));
  assert.equal(await importContentBackup(backup), 1);
  const restored = await loadDocuments();
  assert.deepEqual(restored.map(value => value.name), [entry.name, draft.name]);
  assert.notEqual(restored[0].id, restored[1].id);
  assert.deepEqual(restored[1].blocks.map(block => block.kind === 'image' ? block.dataUrl : ''), [entry.blocks[0].dataUrl]);
  const invalid = JSON.stringify({ ...backup, libraries: { ...backup.libraries, document: [draft, { invalid: true }] } });
  assert.throws(() => parseContentBackup(invalid), /Invalid document entry/);
  assert.equal((await loadDocuments()).length, 2, 'invalid imports do not partially change the library');
});

it('#6695 an unfinished image remains recoverable beside valid document, comparison and validation evidence', async () => {
  const { comparisonModels, comparisonResult } = await import('@/test/saved-comparison-fixture');
  const { snapshotComparison } = await import('../compare/savedComparisons');
  const { newSavedReport } = await import('../validation/reports/history');
  const { emptyManualReportBlock } = await import('../document/manual-report');
  const library = documents(), saved = { ...blankDocument(), name: 'Complete saved evidence' };
  const comparison = snapshotComparison(comparisonResult('A', 'B'), comparisonModels(), 'Complete comparison');
  const report = newSavedReport(emptyManualReportBlock('complete-manual'), 'Complete validation');
  assert.equal(await library.put(saved.id, saved), true);
  const incomplete = { ...blankDocument(), name: 'Unfinished image draft', blocks: [
    { kind: 'image' as const, id: 'pending-image', dataUrl: '', height: 60, align: 'left' as const },
  ] };
  assert.equal(await library.put(incomplete.id, incomplete), false);
  assert.equal(library.status().items[incomplete.id], 'invalid');
  const exported = JSON.stringify(createContentBackup({ validation: [report], comparison: [comparison], document: library.entries() }));
  assert.ok(exported.includes('pending-image'), 'preserve raw unfinished image evidence');
  const parsed = parseContentBackup(exported);
  assert.deepEqual(parsed.libraries.document, [saved]);
  assert.deepEqual(parsed.libraries.comparison, [comparison]);
  assert.deepEqual(parsed.libraries.validation, [report]);
  assert.deepEqual(parsed.drafts, [{ kind: 'document', id: incomplete.id, raw: JSON.stringify(incomplete) }]);
  await clearContentDatabase();
  assert.equal(await importContentBackup(parsed), 3);
  assert.deepEqual(await loadDocuments(), [saved]);
  assert.deepEqual((await readContentRows('comparison')).map(row => row.payload), [comparison]);
  assert.deepEqual((await readContentRows('validation')).map(row => row.payload), [report]);
  const preserved = await readBackupDrafts();
  assert.equal(preserved.complete, true);
  assert.deepEqual(preserved.drafts, parsed.drafts);
  const reexported = parseContentBackup(JSON.stringify(createContentBackup(parsed.libraries, undefined, preserved.drafts)));
  assert.deepEqual(reexported.drafts, parsed.drafts, 'a further export retains the original unfinished draft bytes');
  assert.equal(await importContentBackup(reexported), 0, 'raw archives and valid evidence are idempotent');
  const raw = (await readContentRecovery()).filter(row => row.key.startsWith('backup-draft:'));
  assert.equal(raw.length, 1);
  assert.deepEqual(JSON.parse(raw[0].raw), parsed.drafts?.[0]);
});

it('#6695 JSON sparse report arrays remain raw recovery evidence without poisoning valid neighbors', async () => {
  const { newSavedReport, validateSavedReport } = await import('../validation/reports/history');
  const { emptyManualReportBlock } = await import('../document/manual-report');
  const { comparisonModels, comparisonResult } = await import('@/test/saved-comparison-fixture');
  const { snapshotComparison } = await import('../compare/savedComparisons');
  const complete = newSavedReport(emptyManualReportBlock('complete'), 'Complete validation');
  const incomplete = newSavedReport({ kind: 'ids-report', id: 'sparse', sourceName: 'Sparse IDS',
    generatedAt: '2026-01-01T00:00:00.000Z', summary: { checked: 0, passed: 0, failed: 0, passRate: 100 },
    checks: new Array<import('../document/types').IdsReportCheckSummary>(1) }, 'Sparse validation');
  assert.equal(validateSavedReport(incomplete), true, 'native sparse array skips its absent element');
  const raw = JSON.stringify(incomplete);
  assert.equal(validateSavedReport(JSON.parse(raw)), false, 'portable JSON turns the absent element into invalid null');
  const document = blankDocument(), comparison = snapshotComparison(comparisonResult('A', 'B'), comparisonModels(), 'Complete comparison');
  const backup = parseContentBackup(JSON.stringify(createContentBackup({ document: [document], comparison: [comparison], validation: [complete, incomplete] })));
  assert.deepEqual(backup.drafts, [{ kind: 'validation', id: incomplete.id, raw }]);
  assert.equal(await importContentBackup(backup), 3);
  assert.deepEqual(await loadDocuments(), [document]);
  assert.deepEqual((await readContentRows('validation')).map(row => row.payload), [complete]);
  assert.deepEqual((await readContentRows('comparison')).map(row => row.payload), [comparison]);
  const preserved = await readBackupDrafts();
  const reexported = parseContentBackup(JSON.stringify(createContentBackup(backup.libraries, undefined, preserved.drafts)));
  assert.deepEqual(reexported.drafts, [{ kind: 'validation', id: incomplete.id, raw }]);
  assert.equal(await importContentBackup(reexported), 0);
  const original = (await readContentRecovery()).find(row => row.key.startsWith('backup-draft:')); assert.ok(original);
  assert.equal((JSON.parse(original.raw) as { raw: string }).raw, raw, 'archival preserves exact portable sparse draft bytes');
});

it('#6695 an aborted raw-draft archive rolls back all valid neighbors and leaves recovery exportable', async () => {
  const entry = blankDocument(), incomplete = { ...blankDocument(), blocks: [
    { kind: 'image' as const, id: 'pending-image', dataUrl: '', height: 60, align: 'left' as const },
  ] };
  const backup = createContentBackup({ validation: [], comparison: [], document: [entry, incomplete] });
  const original = IDBObjectStore.prototype.put;
  const aborted = mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = original.call(this, value, key);
    if (this.name === 'recovery') this.transaction.abort();
    return request;
  });
  try { await assert.rejects(importContentBackup(backup), /User content transaction (aborted|failed)/); }
  finally { aborted.mock.restore(); }
  assert.deepEqual(await readContentRows('document'), [], 'valid neighbors share the recovery transaction rollback');
  const tx = await contentTransaction('recovery', 'readonly'), done = transactionDone(tx);
  const [committed] = await Promise.all([requestValue(tx.objectStore('recovery').getAll()), done]);
  assert.deepEqual(committed, [], 'no raw archive committed');
  const downloadable = createContentBackup({ validation: [], comparison: [], document: [] });
  assert.deepEqual(downloadable.drafts, backup.drafts, 'failed archival remains exportable in this session');
  assert.equal(await importContentBackup(backup), 1);
  assert.deepEqual(await loadDocuments(), [entry]);
  assert.deepEqual((await readBackupDrafts()).drafts, backup.drafts);
});

it('#6695 malformed draft evidence rejects the whole import before valid neighbors can commit', async () => {
  const entry = blankDocument(), backup = createContentBackup({ validation: [], comparison: [], document: [entry] });
  for (const draft of [{ kind: 'document', id: 'broken', raw: '{' },
    { kind: ['document'], id: entry.id, raw: JSON.stringify(entry) },
    // #6842: a registry guard must exclude Object.prototype and unknown kinds.
    { kind: 'constructor', id: entry.id, raw: JSON.stringify(entry) },
    { kind: 'unregistered-proposal', id: entry.id, raw: JSON.stringify(entry) },
    { kind: 'document', id: 'different', raw: JSON.stringify(entry) }]) {
    await assert.rejects(importContentBackup({ ...backup, drafts: [draft] } as unknown as typeof backup));
    assert.deepEqual(await readContentRows('document'), []);
  }
});

it('#6679 older-tab writes are recoverable without overwriting new content or deleting changed legacy values', async () => {
  await clearContentDatabase();
  const entry = blankDocument();
  localStorage.setItem(documentContent.legacyKey, JSON.stringify([entry]));
  const library = documents(); await library.initialize();
  await library.put(entry.id, { ...entry, name: 'Current version' });
  const legacy = JSON.stringify([{ ...entry, name: 'Old tab version' }]);
  localStorage.setItem(documentContent.legacyKey, legacy);
  await preserveLegacyChange(documentContent.legacyKey, legacy);
  await cleanupContentLegacy();
  assert.equal(localStorage.getItem(documentContent.legacyKey), legacy);
  assert.equal((await loadDocuments())[0].name, 'Current version');
  assert.ok((await readContentRecovery()).some(value => value.raw === legacy));
});

it('#6679 a newer incomplete draft survives the completion of an earlier valid save', async () => {
  const library = documents();
  const entry = blankDocument();
  const earlier = library.put(entry.id, entry);
  const incomplete = { ...entry, blocks: [{ kind: 'image' as const, id: 'pending-image', dataUrl: '', height: 60, align: 'left' as const }] };
  assert.equal(await library.put(entry.id, incomplete), false);
  assert.equal(await earlier, true);
  assert.equal(library.status().items[entry.id], 'invalid');
  assert.deepEqual(library.entries()[0].blocks, incomplete.blocks);
  assert.deepEqual((await loadDocuments())[0].blocks, entry.blocks);
  await library.refresh();
  assert.deepEqual(library.entries()[0].blocks, incomplete.blocks);
});

it('#6679 failed restore preserves drafts; successful restore adopts the other tab version', async () => {
  const first = documents(), second = documents();
  const entry = blankDocument(); await first.put(entry.id, entry); await second.initialize();
  await first.put(entry.id, { ...entry, name: 'Other tab version' });
  await second.put(entry.id, { ...entry, name: 'My draft' });
  const original = IDBDatabase.prototype.transaction;
  const blocked = mock.method(IDBDatabase.prototype, 'transaction', function (this: IDBDatabase,
    stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
    if (stores === 'items' && mode === 'readonly') throw new DOMException('Read blocked', 'SecurityError');
    return original.call(this, stores, mode, options);
  });
  try {
    assert.equal(await second.restore(), false);
    assert.equal(second.entries()[0].name, 'My draft');
    assert.equal(second.status().items[entry.id], 'conflict');
  } finally { blocked.mock.restore(); }
  assert.equal(await second.restore(), true);
  assert.equal(second.entries()[0].name, 'Other tab version');
  assert.deepEqual(Object.keys(second.status().items), []);
});

it('#6679 repeated conflict imports remain idempotent after their imported copy is deleted', async () => {
  const library = documents(), entry = blankDocument(); await library.put(entry.id, entry);
  const backup = createContentBackup({ document: [{ ...entry, name: 'Imported version' }], validation: [], comparison: [] });
  assert.equal(await importContentBackup(backup), 1);
  assert.equal(await importContentBackup(backup), 0);
  await library.refresh();
  const copy = library.entries().find(value => value.id !== entry.id); assert.ok(copy);
  await library.put(copy.id, null);
  assert.equal(await importContentBackup(backup), 0);
  assert.deepEqual((await loadDocuments()).map(value => value.id), [entry.id]);
});

it('#6679 refused migration keeps verified legacy neighbours exportable before retry', async () => {
  await clearContentDatabase();
  const entry = blankDocument(), raw = JSON.stringify([entry]);
  localStorage.setItem(documentContent.legacyKey, raw);
  const library = documents(), refused = refuseContentWrites();
  try {
    assert.equal(await library.initialize(), false);
    assert.deepEqual(library.entries(), [entry]);
    assert.equal(library.status().phase, 'unavailable');
    assert.equal(library.status().items[entry.id], 'quota');
    const backup = createContentBackup({ document: library.entries(), validation: [], comparison: [] });
    assert.deepEqual(parseContentBackup(JSON.stringify(backup)).libraries.document, [entry]);
    assert.ok((await readContentRecovery()).some(original => original.raw === raw));
    assert.deepEqual(await readContentRows('document'), []);
  } finally { refused.mock.restore(); }
  assert.equal(await library.retry(), true);
  assert.deepEqual((await loadDocuments()).map(document => document.id), [entry.id]);
});

it('#6679 model-cache cleanup preserves saved documents and migration originals', async () => {
  await clearContentDatabase();
  const entry = blankDocument(), raw = JSON.stringify([entry]);
  localStorage.setItem(documentContent.legacyKey, raw);
  const library = documents(); await library.initialize();
  const { clearCache } = await import('../../services/ifc-cache');
  await clearCache();
  assert.deepEqual(await loadDocuments(), [entry]);
  assert.ok((await readContentRecovery()).some(original => original.raw === raw));
});

it('#6679 conflict imports keep document charts and report pickers bound to their imported evidence', async () => {
  const { comparisonModels, comparisonResult } = await import('@/test/saved-comparison-fixture');
  const { snapshotComparison } = await import('../compare/savedComparisons');
  const { loadSavedComparisons } = await import('../compare/savedComparisonPersistence');
  const { newSavedReport, savedReportBlock } = await import('../validation/reports/history');
  const { loadValidationReports } = await import('../validation/reports/persistence');
  const { emptyManualReportBlock } = await import('../document/manual-report');
  const { resolveComparisonChartSource } = await import('../charts/comparison-source');
  const comparison = snapshotComparison(comparisonResult('A', 'B'), comparisonModels(), 'Existing comparison');
  const report = newSavedReport(emptyManualReportBlock('manual-block'), 'Existing validation');
  assert.equal((await writeContent('comparison', comparison.id, comparison, 0)).ok, true);
  assert.equal((await writeContent('validation', report.id, report, 0)).ok, true);
  const incomingComparison = { ...snapshotComparison(comparisonResult('A', 'C'), comparisonModels(), 'Imported comparison'), id: comparison.id };
  const incomingReport = { ...report, name: 'Imported validation', snapshot: { ...emptyManualReportBlock(report.snapshot.id), savedReportId: report.id, checklistName: 'Imported checklist' } };
  const document: DocumentSpec = { ...blankDocument(), blocks: [
    { kind: 'chart', id: 'bound-chart', snapshot: true, chart: { id: 'chart', title: 'Comparison', type: 'bar', source: 'compare',
      comparisonId: comparison.id, dimension: 'State', measure: { agg: 'count' } } },
    savedReportBlock(incomingReport, 'bound-report'),
  ] };
  const backup = createContentBackup({ document: [document], comparison: [incomingComparison], validation: [incomingReport] });
  assert.equal(await importContentBackup(backup), 3);
  const comparisons = await loadSavedComparisons(), reports = await loadValidationReports(), [restored] = await loadDocuments();
  const importedComparison = comparisons.find(entry => entry.id !== comparison.id); assert.ok(importedComparison);
  const importedReport = reports.find(entry => entry.id !== report.id); assert.ok(importedReport);
  const chart = restored.blocks[0], block = restored.blocks[1];
  assert.ok(chart.kind === 'chart' && block.kind === 'manual-report');
  assert.equal(chart.chart.comparisonId, importedComparison.id);
  assert.equal(block.savedReportId, importedReport.id);
  assert.equal(block.checklistName, 'Imported checklist');
  const source = resolveComparisonChartSource(chart.chart, { source: 'compare', columns: [], rows: [], fingerprint: 'no-live-result' }, comparisons);
  assert.equal(source.status, 'saved');
  assert.equal(source.name, 'Imported comparison');
  assert.equal(source.dataset.rows.length, incomingComparison.report.rows.length);
  assert.notEqual(source.dataset.rows.length, comparison.report.rows.length, 'chart resolves the imported A/C evidence, not existing A/B');
  assert.equal(await importContentBackup(backup), 0, 'repeated imports resolve the same remapped library IDs');
});
