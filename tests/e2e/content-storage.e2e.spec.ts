/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { writeFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import type { DocumentSpec } from '../../apps/viewer/src/lib/document/types';
import type { RuleSetFile } from '@ifc-lite/rules';

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
