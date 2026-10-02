/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFile, writeFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { DOCUMENT_VERSION, type DocumentSpec } from '../../apps/viewer/src/lib/document/types';
import type { RuleSetFile } from '@ifc-lite/rules';
import type { ContentBackup } from '../../apps/viewer/src/lib/storage/content-backup';

const documentEntry = (id: string, name: string): DocumentSpec => ({ version: 11, id, name,
  page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'text', id: `${id}-body`, style: 'body', text: 'Project: {IfcProject.Name}' }] });
const rules: RuleSetFile = { version: 1, name: 'Storage witness 6679', rules: [{ id: 'wall-names', name: 'Wall names',
  applicability: { authoredAs: 'chips', groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] }] },
  requirement: { kind: 'element', block: { authoredAs: 'chips', groups: [{ combinator: 'AND', rules: [{ kind: 'name', op: 'contains', value: 'right' }] }] } },
}] };

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state?.documentsStorage.phase === 'ready' && state.validationReportsStorage.phase === 'ready';
  });
}
async function openDocument(page: Page, id: string): Promise<void> {
  await page.evaluate(id => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.setActiveDocumentId(id); state.showWorkspacePanel('document'); state.setSidebarActivePanel('model');
  }, id);
  await expect(page.locator('[data-document-panel]').first()).toBeVisible();
}

test('#6679 migrates and reopens large libraries alongside real SketchUp validation evidence', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  const original = documentEntry('legacy-6679', 'Migrated cover');
  await page.addInitScript(entry => {
    if (!sessionStorage.getItem('seeded-6679')) {
      localStorage.setItem('ifc-lite-documents', JSON.stringify([entry])); sessionStorage.setItem('seeded-6679', 'yes');
    }
  }, original);
  const loaded = page.waitForEvent('console', { predicate: message => message.text().includes('[ifc-lite] Added model building-architecture.ifc') });
  await page.goto('/?model=/samples/building-architecture.ifc'); await loaded; await ready(page);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().documents.map(entry => entry.id))).toEqual([original.id]);
  await page.evaluate(file => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.setValidationRuleSetDraft(file); state.setValidationRuleSetEditing(true);
    state.showWorkspacePanel('validation'); state.setSidebarActivePanel('validation');
  }, rules);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('button', { name: 'Save report', exact: true }).click();
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return state.savedValidationReports.length === 1 && Object.values(state.validationReportsStorage.items).includes('saved');
  });
  const evidence = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().savedValidationReports[0]);
  await writeFile(info.outputPath('saved-validation-report.json'), JSON.stringify(evidence, null, 2));
  await page.screenshot({ path: info.outputPath('saved-validation-report-sketchup.png') });
  expect(evidence.snapshot.kind).toBe('ids-report');
  expect(evidence.snapshot.reportModels?.length).toBeGreaterThan(0);
  const bytes = await page.evaluate(async () => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const entries = Array.from({ length: 8 }, (_, index): DocumentSpec => ({ version: 11, id: `large-6679-${index}`, name: `Large evidence ${index}`,
      page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'text', id: `large-body-${index}`, style: 'body', text: 'Measured evidence '.repeat(50_000) }] }));
    if (!(await Promise.all(entries.map(entry => state.upsertDocument(entry)))).every(Boolean)) throw new Error('Large library was not committed');
    return new Blob([JSON.stringify(entries)]).size;
  });
  expect(bytes).toBeGreaterThan(5 * 1024 * 1024);
  await openDocument(page, original.id);
  await page.waitForFunction(() => (globalThis.__ifc_lite_viewer_store__.getState().geometryResult?.meshes.length ?? 0) > 0);
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.fitAll?.());
  await page.waitForTimeout(500); // Let camera fitting submit the model frame before the screenshot.
  await page.locator('[data-document-panel]').first().locator('summary').filter({ hasText: 'Storage and backup' }).click();
  const download = page.waitForEvent('download');
  await page.locator('[data-document-panel]').first().getByRole('button', { name: 'Download library backup', exact: true }).click();
  await (await download).saveAs(info.outputPath('large-library-backup.json'));
  await page.screenshot({ path: info.outputPath('indexeddb-large-library-sketchup.png') });
  await page.reload(); await ready(page);
  const restored = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return { documents: state.documents.map(entry => ({ id: entry.id, blocks: entry.blocks })), reports: state.savedValidationReports };
  });
  expect(restored.documents).toHaveLength(9);
  expect(restored.documents.find(entry => entry.id === 'large-6679-7')?.blocks[0]).toMatchObject({ text: 'Measured evidence '.repeat(50_000) });
  expect(restored.reports).toEqual([evidence]);
  expect(await page.evaluate(() => localStorage.getItem('ifc-lite-documents'))).toBe(JSON.stringify([original]));
});

test('#6679 refused commits remain exportable and two tabs cannot overwrite drafts', async ({ page, context }, info) => {
  await page.goto('/'); await ready(page);
  const entry = documentEntry('conflict-6679', 'Initial saved version');
  expect(await page.evaluate(entry => globalThis.__ifc_lite_viewer_store__.getState().upsertDocument(entry), entry)).toBe(true);
  await openDocument(page, entry.id);
  const refused = await page.evaluate(async entry => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
      if (mode === 'readwrite' && (stores === 'items' || Array.isArray(stores) && stores.includes('items'))) throw new DOMException('Storage full', 'QuotaExceededError');
      return original.call(this, stores, mode, options);
    };
    try { return await globalThis.__ifc_lite_viewer_store__.getState().upsertDocument({ ...entry, name: 'Exportable unsaved draft' }); }
    finally { IDBDatabase.prototype.transaction = original; }
  }, entry);
  expect(refused).toBe(false);
  await expect(page.locator('[data-document-panel]').first().getByRole('alert').filter({ hasText: 'Browser storage is full' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('quota-keeps-draft.png') });
  await page.locator('[data-document-panel]').first().getByRole('button', { name: 'Retry save', exact: true }).click();
  await page.waitForFunction(id => globalThis.__ifc_lite_viewer_store__.getState().documentsStorage.items[id] === 'saved', entry.id);
  const other = await context.newPage(); await other.goto('/'); await ready(other); await openDocument(other, entry.id);
  await other.evaluate(id => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const document = state.documents.find(entry => entry.id === id); if (!document) throw new Error('Shared document missing');
    state.stageDocument({ ...document, name: 'Second tab draft' });
  }, entry.id);
  expect(await page.evaluate(entry => globalThis.__ifc_lite_viewer_store__.getState().upsertDocument({ ...entry, name: 'First tab committed' }), entry)).toBe(true);
  await other.waitForFunction(id => globalThis.__ifc_lite_viewer_store__.getState().documentsStorage.items[id] === 'conflict', entry.id);
  await expect(other.locator('[data-document-panel]').first().getByRole('alert').filter({ hasText: 'Another tab changed' })).toBeVisible();
  expect(await other.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().retryDocumentsSave())).toBe(false);
  expect(await other.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().documents[0].name)).toBe('Second tab draft');
  await other.screenshot({ path: info.outputPath('two-tab-conflict.png') });
  expect(await other.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().restoreDocuments())).toBe(true);
  expect(await other.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().documents[0].name)).toBe('First tab committed');
  // An older application still writes localStorage. Preserve it without replaying
  // its deletion, and keep the recovery notice across subsequent committed edits.
  await other.evaluate(() => localStorage.setItem('ifc-lite-documents', '[]'));
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__.getState().documentsStorage.recovered);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().documents[0].name)).toBe('First tab committed');
  expect(await page.evaluate(entry => globalThis.__ifc_lite_viewer_store__.getState().upsertDocument({ ...entry, name: 'Current edit after legacy change' }), entry)).toBe(true);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().documentsStorage.recovered)).toBe(true);
  await other.close();
});

test('#6695 repeated quota-refused backup imports preserve one edited draft through retry and reload', async ({ page }, info) => {
  await page.goto('/'); await ready(page); await openDocument(page, 'import-dedup-panel');
  const neighbours = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().documents);
  expect(neighbours).toHaveLength(1);
  const entry = documentEntry('external-6695', 'Import once'), backup: ContentBackup = { version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z', libraries: { document: [entry], comparison: [], validation: [] } };
  const file = { name: 'same-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) };
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
      if (mode === 'readwrite' && (stores === 'items' || Array.isArray(stores) && stores.includes('items'))) throw new DOMException('Storage full', 'QuotaExceededError');
      return original.call(this, stores, mode, options);
    };
    (globalThis as { restoreContentTransaction?: () => void }).restoreContentTransaction = () => { IDBDatabase.prototype.transaction = original; };
  });
  const panel = page.locator('[data-document-panel]').first(), input = panel.getByLabel('Import library backup', { exact: true });
  await input.setInputFiles(file);
  await page.waitForFunction(id => globalThis.__ifc_lite_viewer_store__.getState().documents.some(entry => entry.id === id), entry.id);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().documents)).toHaveLength(neighbours.length + 1);
  const refusedNotice = page.locator('[data-toast-seq]').filter({ hasText: 'The backup was not saved.' });
  await expect(refusedNotice).toBeVisible();
  await refusedNotice.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(panel.getByRole('button', { name: 'Retry save', exact: true })).toBeEnabled();
  await page.evaluate(id => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const imported = state.documents.find(entry => entry.id === id);
    if (!imported) throw new Error('Imported draft missing');
    state.stageDocument({ ...imported, name: 'Author edit kept' });
  }, entry.id);
  await input.setInputFiles(file);
  await expect(refusedNotice).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Retry save', exact: true })).toBeEnabled();
  expect(await page.evaluate(id => globalThis.__ifc_lite_viewer_store__.getState().documents.filter(entry => entry.id === id).map(entry => entry.name), entry.id)).toEqual(['Author edit kept']);
  expect(await page.evaluate(id => globalThis.__ifc_lite_viewer_store__.getState().documents.filter(entry => entry.id !== id), entry.id)).toEqual(neighbours);
  await page.screenshot({ path: info.outputPath('repeated-quota-import-one-draft.png') });
  await page.evaluate(() => (globalThis as { restoreContentTransaction?: () => void }).restoreContentTransaction?.());
  await panel.getByRole('button', { name: 'Retry save', exact: true }).click();
  await page.waitForFunction(() => Object.values(globalThis.__ifc_lite_viewer_store__.getState().documentsStorage.items).every(value => value === 'saved'));
  await page.reload(); await ready(page); await openDocument(page, entry.id);
  await input.setInputFiles(file);
  await expect(page.getByText('Imported 0 items.', { exact: false })).toBeVisible();
  expect(await page.evaluate(id => globalThis.__ifc_lite_viewer_store__.getState().documents.filter(entry => entry.id === id).map(entry => entry.name), entry.id)).toEqual(['Author edit kept']);
  expect(await page.evaluate(id => globalThis.__ifc_lite_viewer_store__.getState().documents.filter(entry => entry.id !== id), entry.id)).toEqual(neighbours);
});

test('#6695 an unfinished image round-trips as raw evidence without poisoning valid library imports', async ({ page, browser }, info) => {
  await page.goto('/'); await ready(page);
  const saved = documentEntry('complete-6695', 'Complete document beside unfinished image');
  const migratedSaved = { ...saved, version: DOCUMENT_VERSION };
  const incomplete: DocumentSpec = { ...documentEntry('unfinished-6695', 'Unfinished image evidence'), blocks: [
    { kind: 'image', id: 'pending-image-6695', dataUrl: '', height: 60, align: 'left' },
  ] };
  expect(await page.evaluate(entry => globalThis.__ifc_lite_viewer_store__.getState().upsertDocument(entry), saved)).toBe(true);
  expect(await page.evaluate(entry => globalThis.__ifc_lite_viewer_store__.getState().upsertDocument(entry), incomplete)).toBe(false);
  await openDocument(page, saved.id);
  const panel = page.locator('[data-document-panel]').first();
  await panel.locator('summary').filter({ hasText: 'Storage and backup' }).click();
  const downloaded = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download library backup', exact: true }).click();
  const exportedPath = info.outputPath('unfinished-draft-library-backup.json');
  await (await downloaded).saveAs(exportedPath);
  const text = await readFile(exportedPath, 'utf8'), backup = JSON.parse(text) as ContentBackup;
  expect(backup.libraries.document).toEqual([migratedSaved]);
  expect(backup.drafts).toEqual([{ kind: 'document', id: incomplete.id, raw: JSON.stringify(incomplete) }]);

  // A fresh browser profile has no saved source library or in-memory raw sidecar.
  const target = await browser.newContext({ baseURL: new URL(page.url()).origin }), restored = await target.newPage();
  try {
    await restored.goto('/'); await ready(restored);
    await openDocument(restored, 'new-import-panel');
    const restoredPanel = restored.locator('[data-document-panel]').first();
    await restoredPanel.getByLabel('Import library backup', { exact: true }).setInputFiles({ name: 'unfinished.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await expect(restored.getByText('Preserved 1 incomplete draft as raw recovery evidence.', { exact: false })).toBeVisible();
    // The persistence notice precedes the asynchronous visible-library refresh.
    await expect.poll(() => restored.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().documents.find(entry => entry.id === 'complete-6695'))).toEqual(migratedSaved);
    expect(await restored.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().documents.some(entry => entry.id === 'unfinished-6695'))).toBe(false);
    await restored.reload(); await ready(restored); await openDocument(restored, saved.id);
    await restoredPanel.locator('summary').filter({ hasText: 'Storage and backup' }).click();
    const reexport = restored.waitForEvent('download');
    await restoredPanel.getByRole('button', { name: 'Download library backup', exact: true }).click();
    const reexportPath = info.outputPath('reexported-draft-library-backup.json');
    await (await reexport).saveAs(reexportPath);
    expect((JSON.parse(await readFile(reexportPath, 'utf8')) as ContentBackup).drafts).toEqual(backup.drafts);
    const originals = restored.waitForEvent('download');
    await restoredPanel.getByRole('button', { name: 'Download preserved originals', exact: true }).click();
    const originalsPath = info.outputPath('unfinished-draft-preserved-originals.json');
    await (await originals).saveAs(originalsPath);
    const raw = JSON.parse(await readFile(originalsPath, 'utf8')) as Array<{ key: string; raw: string }>;
    const archives = raw.filter(row => row.key.startsWith('backup-draft:'));
    expect(archives.map(row => JSON.parse(row.raw))).toEqual(backup.drafts);
    expect((JSON.parse(archives[0].raw) as { raw: string }).raw).toBe(JSON.stringify(incomplete));
    await restored.screenshot({ path: info.outputPath('unfinished-draft-roundtrip.png') });
  } finally { await target.close(); }
});
