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
import { clearContentDatabase } from '@/test/content-fixture.js';
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
import { cleanup, click, render, waitFor } from '@/test/render';
import { detectCoincidentWalls, mountClashPanel, saveCurrentResultAs, savedClashReports } from '@/test/clash-report-fixture';
import { readContentRows, writeContent } from './content-database';
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
