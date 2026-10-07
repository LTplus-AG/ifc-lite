/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saved clash reports in the library backup (#6947): export, import into an
 * empty browser, a conflicting import, and files written before the feature.
 * The reports are produced by the real Clash panel over real detection runs
 * (2 coincident walls: 1 clash; 3 walls: 3 clashes).
 */

import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import { clearContentDatabase, refuseContentWrites } from '@/test/content-fixture.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { ChartSpec } from '@ifc-lite/charts';
import { blankDocument } from '../document/presets';
import { loadDocuments } from '../document/persistence';
import { prepareDocument } from '../document/prepare-document';
import type { DocumentSpec } from '../document/types';
import type { SavedClashReport } from '../clash/saved-report-schema';
import { useViewerStore } from '@/store';
import '@/test/download-capture';
import { Toaster } from '@/components/ui/toast';
import { ContentStorageNotice } from '@/components/viewer/ContentStorageNotice';
import { assistantLibrary } from '@/lib/assistant/library';
import { cleanup, click, render, type, waitFor } from '@/test/render';
import { detectCoincidentWalls, mountClashPanel, openSavedReports, saveCurrentResultAs, savedClashReports } from '@/test/clash-report-fixture';
import { contentTransaction, readContentRows, transactionDone, writeContent, type ContentRow } from './content-database';
import { rebindCommittedDocument } from './content-backup-references';
import { forgetContentImports, planContentImport, prepareContentImport, rememberContentImports } from './content-import-plan';
import type { ContentKind } from './content-kinds';
import { createContentBackup, importContentBackup, parseContentBackup, type ContentLibraries } from './content-backup';

const original = useViewerStore.getState();
let a: SavedClashReport, b: SavedClashReport;

beforeEach(async () => {
  localStorage.clear();
  act(() => useViewerStore.setState({ mutationVersion: 0, mutationViews: new Map(), clashReviews: new Map(), clashExclusions: [] }));
  mountClashPanel();
  await detectCoincidentWalls(2, 1, () => ({ sourceFingerprint: 'revision-1' }));
  a = await saveCurrentResultAs('Run A');
  await detectCoincidentWalls(3, 1, () => ({ sourceFingerprint: 'revision-2' }));
  b = await saveCurrentResultAs('Run B');
});
afterEach(() => { cleanup(); useViewerStore.setState(original); localStorage.clear(); });

const clashChart = (id: string, clashReportId?: string): ChartSpec => ({ id, title: id, source: 'clash', type: 'bar', dimension: 'Rule', measure: { agg: 'count' },
  ...(clashReportId ? { clashReportId } : {}) });
function documentOf(...charts: ChartSpec[]): DocumentSpec {
  return { ...blankDocument(), name: 'Clash runs', blocks: charts.map((chart) => ({ kind: 'chart' as const, id: `block-${chart.id}`, chart, snapshot: false })) };
}
const bindings = (document: DocumentSpec): Array<string | undefined> =>
  document.blocks.map((block) => block.kind === 'chart' ? block.chart.clashReportId : undefined);
const libraries = (extra: Partial<ContentLibraries>): ContentLibraries => ({ validation: [], comparison: [], document: [], ...extra });

/** Another browser: an empty saved content library and nothing in memory. */
async function emptyBrowser(): Promise<void> {
  cleanup();
  await act(async () => {
    await clearContentDatabase();
    useViewerStore.setState({ ...original, mutationVersion: 0 });
    await useViewerStore.getState().restoreSavedClashReports();
  });
  assert.deepEqual(savedClashReports(), []);
}
const refresh = () => act(async () => { await useViewerStore.getState().refreshSavedClashReports(); });
async function totals(document: DocumentSpec): Promise<Array<number | undefined>> {
  const prepared = await prepareDocument(document, useViewerStore.getState());
  return document.blocks.map((block) => prepared.aggregations.get(block.id)?.total);
}

function Notice() {
  const status = useViewerStore((state) => state.documentsStorage);
  return <ContentStorageNotice status={status} retry={() => useViewerStore.getState().retryDocumentsSave()}
    restore={() => useViewerStore.getState().restoreDocuments()} />;
}

describe('Saved clash reports in the library backup (#6947)', () => {
  it('the Storage and backup controls download the reports and import them into an empty browser', async () => {
    // The download helper hands its Blob to URL.createObjectURL; keep that Blob to read the file the user would get.
    const blobs: Blob[] = [];
    const createObjectURL = URL.createObjectURL;
    URL.createObjectURL = (blob: Blob | MediaSource): string => { blobs.push(blob as Blob); return createObjectURL(blob); };
    try {
      // The app opens every library at startup; the backup button waits for all of them.
      await act(async () => { await assistantLibrary.initialize(); });
      const ui = render(<><Notice /><Toaster /></>);
      const download = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Download library backup'); assert.ok(download);
      await waitFor(() => !download.disabled, 'the libraries finish loading');
      click(download);
      await waitFor(() => blobs.length === 1, 'the backup file is produced');
      const file = await blobs[0].text();
      assert.deepEqual(parseContentBackup(file).libraries.clashReports?.map((entry) => JSON.stringify(entry)).sort(), [a, b].map((entry) => JSON.stringify(entry)).sort(),
        'the downloaded backup holds both saved clash reports');

      await emptyBrowser();
      const imported = render(<><Notice /><Toaster /></>);
      const input = imported.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
      Object.defineProperty(input, 'files', { value: [new File([file], 'ifc-lite-library-backup.json', { type: 'application/json' })], configurable: true });
      await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
      await waitFor(() => savedClashReports().length === 2, 'the import shows both reports without a reload');
      assert.deepEqual(savedClashReports().map((entry) => JSON.stringify(entry)).sort(), [a, b].map((entry) => JSON.stringify(entry)).sort());
      assert.equal((await readContentRows('clashReports' as ContentKind)).filter((row) => !row.deleted).length, 2, 'and they are written to the saved content library');
    } finally { URL.createObjectURL = createObjectURL; }
  });

  it('export then import restores the reports and the chart bindings exactly', async () => {
    const document = documentOf(clashChart('of-a', a.id), clashChart('of-b', b.id), clashChart('current'));
    const exported = JSON.stringify(createContentBackup(libraries({ document: [document], clashReports: savedClashReports() })));
    assert.deepEqual(JSON.parse(exported).libraries.clashReports.map((entry: SavedClashReport) => entry.id).sort(), [a.id, b.id].sort(), 'the backup file carries both reports');

    await emptyBrowser();
    assert.equal(await importContentBackup(parseContentBackup(exported)), 3, 'two reports and the document');
    await refresh();
    const restored = savedClashReports();
    for (const report of [a, b]) {
      assert.equal(JSON.stringify(restored.find((entry) => entry.id === report.id)), JSON.stringify(report), `"${report.name}" is restored field for field`);
    }
    const [restoredDocument] = await loadDocuments();
    assert.deepEqual(bindings(restoredDocument), [a.id, b.id, undefined], 'each chart still names its own report; the unbound chart stays unbound');
    assert.deepEqual(await totals(restoredDocument), [1, 3, 0], 'the imported charts read their reports; with no current result the unbound chart is empty');
    assert.equal(await importContentBackup(parseContentBackup(exported)), 0, 'importing the same file again adds nothing');
  });

  it('a conflicting import keeps the local report, adds the imported one as a copy, and the imported chart follows the copy', async () => {
    // The file holds different evidence (run B's rows) under run A's id.
    const incoming: SavedClashReport = { ...b, id: a.id, name: 'Imported under the same id' };
    const document = documentOf(clashChart('imported-chart', a.id));
    const backup = createContentBackup(libraries({ document: [document], clashReports: [incoming] }));
    assert.equal(await importContentBackup(backup), 2);
    await refresh();
    const local = savedClashReports().find((entry) => entry.id === a.id);
    assert.equal(JSON.stringify(local), JSON.stringify(a), 'the local evidence under that id is untouched');
    const copy = savedClashReports().find((entry) => entry.name === 'Imported under the same id');
    assert.ok(copy && copy.id !== a.id, 'the imported evidence arrives under a new id');
    assert.equal(copy.clashes.length, 3);
    const restoredDocument = (await loadDocuments()).find((entry) => entry.name === 'Clash runs');
    assert.ok(restoredDocument);
    assert.deepEqual(bindings(restoredDocument), [copy.id], 'the imported chart reads the evidence it was exported with, not the local report');
    assert.deepEqual(await totals(restoredDocument), [3]);
  });

  it('a retried import that has to give a report a new id takes the document staged by the first attempt with it', async () => {
    const backedUp = documentOf(clashChart('of-a', a.id));
    const prepared = await prepareContentImport(libraries({ clashReports: [a], document: [backedUp] }));
    // First attempt, refused by storage: planned against an empty library, remembered, and its entries staged in this tab.
    const first = planContentImport(prepared, []);
    assert.deepEqual(first.map((row) => [row.kind, row.id]), [['clashReports', a.id], ['document', backedUp.id]], 'control: nothing conflicts yet, so the ids are kept');
    rememberContentImports(first);
    try {
      // Before the retry another tab stores a different run under the same id.
      const peer: ContentRow = { kind: 'clashReports' as ContentKind, id: a.id, version: 1, revision: 1, createdAt: 1, modifiedAt: 1, deleted: false, payload: { ...b, id: a.id } };
      const second = planContentImport(prepared, [peer], libraries({ clashReports: [a], document: [backedUp] }));
      const report = second.find((row) => row.kind === 'clashReports'), staged = second.find((row) => row.kind === 'document');
      assert.ok(report && staged);
      assert.notEqual(report.id, a.id, 'the imported report becomes a copy: the id now belongs to the other run');
      assert.equal((report.payload as SavedClashReport).clashes.length, a.clashes.length);
      assert.deepEqual(bindings(staged.payload as DocumentSpec), [report.id], 'the staged document follows the copy; left on the old id it would chart the other run');
    } finally { forgetContentImports(first); }
  });

  it('a newer draft follows the id an own import gave its saved clash report, and keeps the author edit', () => {
    // What the document content kind does when an import this tab made is acknowledged while a newer draft is waiting.
    const staged = documentOf(clashChart('of-a', a.id));
    const committed: DocumentSpec = { ...staged, blocks: documentOf(clashChart('of-a', 'copy-of-a')).blocks };
    const merged = rebindCommittedDocument({ ...staged, name: 'Edited since the import' }, staged, committed);
    assert.deepEqual([merged.name, bindings(merged)], ['Edited since the import', ['copy-of-a']]);
    // Control: a chart the author has pointed at another report since is not pulled back.
    const repointed: DocumentSpec = { ...staged, blocks: documentOf(clashChart('of-a', b.id)).blocks };
    assert.deepEqual(bindings(rebindCommittedDocument(repointed, staged, committed)), [b.id]);
  });

  it('saved evidence is immutable: only the name can change', async () => {
    const state = useViewerStore.getState();
    assert.equal(await state.saveClashReport({ ...a, clashes: [] }), false, 'replacing the rows under an existing id is refused');
    const row = (await readContentRows('clashReports' as ContentKind)).find((entry) => entry.id === a.id);
    assert.ok(row);
    assert.deepEqual(await writeContent('clashReports' as ContentKind, a.id, { ...a, clashes: [] }, row.revision), { ok: false, reason: 'invalid' },
      'the saved content library itself refuses altered evidence');
    await act(async () => { assert.equal(await state.renameSavedClashReport(a.id, 'Run A renamed'), true); });
    const renamed = savedClashReports().find((entry) => entry.id === a.id);
    assert.equal(JSON.stringify(renamed), JSON.stringify({ ...a, name: 'Run A renamed' }));
  });

  it('staging, the path a refused import takes, cannot replace the evidence of a report already in the library', async () => {
    const state = useViewerStore.getState();
    await act(async () => { await state.stageClashReport({ ...a, clashes: [] }); });
    assert.equal(savedClashReports().find((entry) => entry.id === a.id)?.clashes.length, 1, 'the charts of this tab keep reading the saved rows');
    assert.equal(useViewerStore.getState().savedClashReportsStorage.items[a.id], 'saved', 'and the report is not turned into an unsaved draft');
    // Control: staging is not refused wholesale. A report under a new id is held in this tab until it can be stored.
    await act(async () => { await state.stageClashReport({ ...a, id: 'clash-report-staged', name: 'Staged copy' }); });
    assert.equal(savedClashReports().find((entry) => entry.id === 'clash-report-staged')?.clashes.length, 1);
  });

  it('refuses a name over the 200-character limit without touching the saved report', async () => {
    const state = useViewerStore.getState();
    await act(async () => { assert.equal(await state.renameSavedClashReport(a.id, 'n'.repeat(201)), false, 'a name the report format rejects is refused'); });
    assert.equal(savedClashReports().find((entry) => entry.id === a.id)?.name, 'Run A', 'the refused name is not left in memory as an unsaved draft');
    assert.equal(useViewerStore.getState().savedClashReportsStorage.items[a.id], 'saved', 'and the report is not marked as failing to save');
    await act(async () => { assert.equal(await state.renameSavedClashReport(a.id, 'n'.repeat(200)), true, 'control: the limit itself is accepted'); });
    // The dialog's two name fields cannot exceed the limit in the first place.
    const open = [...document.body.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Saved clash reports'); assert.ok(open); click(open);
    await waitFor(() => document.body.querySelector('input[aria-label="Report name"]') !== null, 'the dialog opens');
    const fields = [...document.body.querySelectorAll<HTMLInputElement>('[role="dialog"] input:not([type="file"])')];
    assert.ok(fields.length >= 3, 'the save field and one rename field per report');
    assert.deepEqual([...new Set(fields.map((field) => field.maxLength))], [200]);
  });

  it('a report the browser refused to store is shown as unsaved in the dialog, and Retry save stores it', async () => {
    const dialog = () => document.body.querySelector('[role="dialog"]');
    const named = (name: string) => [...(dialog()?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.trim() === name);
    const durable = async () => (await readContentRows('clashReports' as ContentKind)).filter((row) => !row.deleted).map((row) => row.id).sort();
    assert.doesNotMatch(dialog()?.textContent ?? '', /Browser storage is full/, 'control: with both reports stored the dialog reports no storage problem');
    const refused = refuseContentWrites();
    let unsaved: SavedClashReport | undefined;
    try {
      const input = dialog()?.querySelector<HTMLInputElement>('input[aria-label="Report name"]'); assert.ok(input);
      type(input, 'Run C');
      const save = named('Save current result'); assert.ok(save); click(save);
      await waitFor(() => {
        unsaved = savedClashReports().find((entry) => entry.name === 'Run C');
        return !!unsaved && useViewerStore.getState().savedClashReportsStorage.items[unsaved.id] === 'quota';
      }, 'the write is refused and the report stays in this tab');
      assert.ok(unsaved);
      assert.deepEqual(await durable(), [a.id, b.id].sort(), 'the reports already stored are untouched and the new one is not stored');
      // The list alone cannot tell the unsaved report from the stored ones; the dialog has to say it.
      assert.match(dialog()?.textContent ?? '', /Browser storage is full\. Your changes remain in this tab\./, 'the dialog says the report is not stored');
    } finally { refused.mock.restore(); }
    const retry = named('Retry save'); assert.ok(retry, 'and offers to store it again');
    click(retry);
    await waitFor(() => useViewerStore.getState().savedClashReportsStorage.items[unsaved?.id ?? ''] === 'saved', 'the retry stores the report');
    assert.deepEqual(await durable(), [a.id, b.id, unsaved.id].sort());
    assert.doesNotMatch(dialog()?.textContent ?? '', /Browser storage is full/);
  });

  it('a library that cannot be read says so in the dialog instead of "No saved clash reports yet"', async () => {
    // A row this build cannot read, as a newer build of the viewer would leave behind: report format 2.
    const tx = await contentTransaction('items', 'readwrite'), done = transactionDone(tx);
    tx.objectStore('items').put({ kind: 'clashReports', id: 'newer', version: 1, revision: 1, createdAt: 1, modifiedAt: 1, deleted: false, payload: { ...a, id: 'newer', version: 2 } });
    await done;
    cleanup();
    await act(async () => {
      useViewerStore.setState({ ...original, mutationVersion: 0 });
      assert.equal(await useViewerStore.getState().refreshSavedClashReports(), false, 'the library refuses to load around a row it cannot read');
    });
    assert.deepEqual(savedClashReports(), []);
    mountClashPanel();
    await openSavedReports();
    const dialog = () => document.body.querySelector('[role="dialog"]')?.textContent ?? '';
    await waitFor(() => !/Loading saved content/.test(dialog()), 'the dialog finishes its own attempt to open the library');
    const text = dialog();
    assert.doesNotMatch(text, /No saved clash reports yet/, 'two readable reports are stored: the list is unread, not empty');
    assert.match(text, /Browser storage is unavailable\./, 'the dialog says the saved reports could not be read');
    assert.deepEqual((await readContentRows('clashReports' as ContentKind)).map((row) => row.id).sort(), [a.id, b.id, 'newer'].sort(), 'and nothing stored was touched');
  });

  it('refuses a backup whose clash report is not a valid report', async () => {
    const backup = (report: unknown) => JSON.stringify({ version: 1, exportedAt: '', libraries: { validation: [], comparison: [], document: [], clashReports: [report] } });
    assert.equal(parseContentBackup(backup(a)).libraries.clashReports?.length, 1, 'control: the real report is accepted');
    const [first] = a.clashes;
    const invalid: Array<[string, unknown]> = [
      ['a row naming a model the report does not list', { ...a, clashes: [{ ...first, a: { ...first.a, model: 'not-in-this-report' } }] }],
      ['an unknown detection status', { ...a, clashes: [{ ...first, status: 'resolved' }] }],
      ['a missing completeness record', { ...a, completeness: undefined }],
      ['a blank name', { ...a, name: '  ' }],
      ['two models under one id', { ...a, models: [...a.models, ...a.models] }],
    ];
    for (const [what, report] of invalid) assert.throws(() => parseContentBackup(backup(report)), /Invalid clashReports entry/, what);
  });

  it('files written before saved clash reports existed load as before', async () => {
    const old = JSON.stringify({ version: 1, exportedAt: '2026-01-01T00:00:00.000Z', libraries: { validation: [], comparison: [],
      document: [documentOf(clashChart('legacy'))] } });
    const parsed = parseContentBackup(old);
    assert.equal(parsed.libraries.clashReports, undefined, 'an absent library stays absent rather than becoming an empty one');
    await emptyBrowser();
    assert.equal(await importContentBackup(parsed), 1);
    const [legacy] = await loadDocuments();
    assert.deepEqual(bindings(legacy), [undefined], 'an existing clash chart gains no binding: it keeps reading the current result');
    mountClashPanel();
    await detectCoincidentWalls(4);
    assert.deepEqual(await totals(legacy), [6], 'and follows the current run, as it always did');
  });
});
