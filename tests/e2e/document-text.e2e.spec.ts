/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test, expect } from '@playwright/test';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
interface DevServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  resolvedUrls: { local: string[] } | null;
}
let vite: DevServer;
let viewerUrl: string;
let viteCache: string;

function mixedFontPdf(): number[] {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UTF16-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 5 >> /DW 1000 >>',
  ];
  const content = 'BT /F1 12 Tf 20 700 Td (Fire rating EI60) Tj /F2 12 Tf 0 -30 Td <65E5672C> Tj ET';
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  let source = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = source.length;
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Array.from(new TextEncoder().encode(source));
}

test.beforeAll(async () => {
  const requireFromViewer = createRequire(join(ROOT, 'apps/viewer/package.json'));
  const { createServer } = await import(pathToFileURL(requireFromViewer.resolve('vite')).href);
  viteCache = await mkdtemp(join(tmpdir(), 'ifc-document-browser-'));
  vite = await createServer({ root: join(ROOT, 'apps/viewer'), cacheDir: viteCache, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  viewerUrl = vite.resolvedUrls?.local[0] ?? '';
  if (!viewerUrl) throw new Error('Vite did not expose its browser test URL');
});

test.afterAll(async () => { await vite.close(); await rm(viteCache, { recursive: true, force: true }); });

test('#4177 production browser resources preserve mixed Latin and CMap text', async ({ page }) => {
  await page.goto(viewerUrl);
  const text = await page.evaluate(async ({ bytes, moduleUrl }) => {
    const documentText: typeof import('../../apps/viewer/src/lib/llm/document-text') = await import(moduleUrl);
    return documentText.extractPdfText(new Blob([new Uint8Array(bytes)]));
  }, { bytes: mixedFontPdf(), moduleUrl: '/src/lib/llm/document-text.ts' });
  expect(text).toContain('Fire rating EI60');
  expect(text).toContain('日本');
});

test('#6488 a popped-out document remains usable after rename, cancel and Escape', async ({ page }, testInfo) => {
  const loaded = page.waitForEvent('console', {
    predicate: (message) => message.text().includes('[ifc-lite] Added model building-architecture.ifc'),
    timeout: 120000,
  });
  await page.goto(`${viewerUrl}?model=/samples/building-architecture.ifc`);
  await loaded;
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.upsertDocument({ version: 1, id: 'popout-6488', name: 'Report', page: { size: 'A4', orientation: 'portrait' }, blocks: [] });
    state.setActiveDocumentId('popout-6488');
    state.showWorkspacePanel('document');
    state.setSidebarActivePanel('document');
    // Exercise the supported window.open path consistently on desktop/headless.
    Object.defineProperty(window, 'documentPictureInPicture', { value: undefined, configurable: true });
  });
  await expect(page.locator('[data-document-panel]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Sidebar options', exact: true }).click();
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('menuitem', { name: 'Pop out to another screen', exact: true }).click();
  const popup = await popupPromise;
  const panel = popup.locator('[data-document-panel]');
  await expect(panel).toBeVisible();
  for (const action of ['save', 'cancel', 'escape'] as const) {
    await panel.getByRole('button', { name: 'Document actions' }).click();
    await popup.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const dialog = popup.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    const input = dialog.getByRole('textbox');
    await expect(input).toBeFocused();
    await input.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Confirm', exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).press('Tab');
    await expect(input).toBeFocused();
    await input.fill(action === 'save' ? 'Renamed report' : 'Discard this');
    if (action === 'save') {
      await popup.screenshot({ path: testInfo.outputPath('document-rename-in-popup.png') });
      await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    } else if (action === 'cancel') await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    else await input.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Document actions' })).toBeFocused();
    await expect(panel.getByRole('combobox', { name: 'Document', exact: true })).toHaveValue('popout-6488');
    expect(await popup.evaluate(() => document.body.style.pointerEvents)).not.toBe('none');
    expect(await page.evaluate(() => document.body.style.pointerEvents)).not.toBe('none');
  }
  await panel.getByRole('button', { name: 'Document actions' }).click();
  await popup.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: 'Document', exact: true }).locator('option:checked')).toHaveText('Renamed report (copy)');
  await popup.screenshot({ path: testInfo.outputPath('document-usable-after-rename.png') });
  await popup.close();
});

test('#6485 named model fields retain their source and authored page breaks export real PDF pages', async ({ page }, testInfo) => {
  const duplicateKeys: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error' && message.text().includes('Encountered two children with the same key')) duplicateKeys.push(message.text()); });
  await page.setViewportSize({ width: 1600, height: 1800 });
  const loaded = page.waitForEvent('console', { predicate: (message) => message.text().includes('[ifc-lite] Added model building-architecture.ifc'), timeout: 120000 });
  await page.goto(`${viewerUrl}?model=/samples/building-architecture.ifc`);
  await loaded;
  const bridgeLoaded = page.waitForEvent('console', { predicate: (message) => message.text().includes('[ifc-lite] Added model infra-bridge.ifc'), timeout: 120000 });
  await page.locator('#file-input-add').setInputFiles(join(ROOT, 'apps/viewer/public/samples/infra-bridge.ifc'));
  await bridgeLoaded;
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.upsertDocument({ version: 8, id: 'sources-6485', name: 'Model sources and page breaks', page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'text', id: 'bridge', style: 'heading', text: '' }] });
    state.setActiveDocumentId('sources-6485');
    state.showWorkspacePanel('document');
    state.setSidebarActivePanel('document');
  });
  const panel = page.locator('[data-document-panel]').first();
  await expect(panel).toBeVisible();
  const bridge = panel.locator('[data-block-editor="bridge"]');
  await bridge.getByRole('combobox', { name: 'Field source model' }).selectOption({ label: 'infra-bridge.ifc' });
  await bridge.getByRole('combobox', { name: 'Insert field', exact: true }).selectOption('Model["infra-bridge.ifc"].Name');
  await expect(panel.locator('[data-preview-block="bridge"] [data-block-text]')).toHaveText('infra-bridge.ifc');
  await panel.getByRole('button', { name: 'Add block', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page break', exact: true }).click();
  await panel.getByRole('button', { name: 'Add block', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Text with fields', exact: true }).click();
  const architecture = panel.locator('[data-block-editor][data-block-kind="text"]').last();
  await architecture.getByRole('combobox', { name: 'Field source model' }).selectOption({ label: 'building-architecture.ifc' });
  await architecture.getByRole('combobox', { name: 'Insert field', exact: true }).selectOption('Model["building-architecture.ifc"].Name');
  await expect(panel.locator('[data-preview-section]')).toHaveCount(2);
  await expect(panel.locator('[data-preview-section]').nth(1).locator('[data-block-text]')).toHaveText('building-architecture.ifc');
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const architecture = [...state.models.values()].find((model) => model.name === 'building-architecture.ifc');
    if (!architecture) throw new Error('Architecture model was not loaded');
    state.setActiveModel(architecture.id);
  });
  await expect(panel.locator('[data-preview-block="bridge"] [data-block-text]')).toHaveText('infra-bridge.ifc');
  await panel.screenshot({ path: testInfo.outputPath('model-sources-page-breaks.png') });
  // The desktop sidebar is narrower than the editor + paper; show both authored
  // sections in the supported document pop-out for reviewable visual evidence.
  await page.evaluate(() => Object.defineProperty(window, 'documentPictureInPicture', { value: undefined, configurable: true }));
  await page.getByRole('button', { name: 'Sidebar options', exact: true }).click();
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('menuitem', { name: 'Pop out to another screen', exact: true }).click();
  const popup = await popupPromise;
  await popup.setViewportSize({ width: 1100, height: 1800 });
  const popupPanel = popup.locator('[data-document-panel]');
  await expect(popupPanel.locator('[data-preview-section]')).toHaveCount(2);
  await expect(popupPanel.locator('[data-preview-block="bridge"] [data-block-text]')).toBeVisible();
  await popupPanel.screenshot({ path: testInfo.outputPath('model-sources-page-breaks-preview.png') });
  await popup.close();
  const downloadPromise = page.waitForEvent('download');
  await panel.locator('[data-document-export]').click();
  const download = await downloadPromise;
  const pdfPath = testInfo.outputPath('model-sources-page-breaks.pdf');
  await download.saveAs(pdfPath);
  const { readFile } = await import('node:fs/promises');
  const bytes = Array.from(await readFile(pdfPath));
  const text = await page.evaluate(async (bytes) => {
    const moduleUrl = '/src/lib/llm/document-text.ts';
    const documentText: typeof import('../../apps/viewer/src/lib/llm/document-text') = await import(moduleUrl);
    return documentText.extractPdfText(new Blob([new Uint8Array(bytes)]));
  }, bytes);
  expect(text).toContain('infra-bridge.ifc');
  expect(text).toContain('building-architecture.ifc');
  expect(text).toContain('[Page 2]');
  expect(text).not.toContain('[Page 3]');
  expect(text).not.toContain('not loaded');
  expect(duplicateKeys).toEqual([]);
});

test('#6500 real IFC checks survive reload and remain independently selectable in documentation', async ({ page }, testInfo) => {
  const loaded = page.waitForEvent('console', {
    predicate: (message) => message.text().includes('[ifc-lite] Added model building-architecture.ifc'),
    timeout: 120000,
  });
  await page.goto(`${viewerUrl}?model=/samples/building-architecture.ifc`);
  await loaded;
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().showWorkspacePanel('validation'));
  await page.getByTestId('validation-entry-ids').click();
  await page.locator('input[type="file"][accept=".ids,.xml"]').last().setInputFiles(join(ROOT, 'apps/viewer/public/samples/building-architecture.ids'));
  await page.getByRole('button', { name: 'Run Validation', exact: true }).click();
  const history = page.locator('[data-saved-validation-reports]');
  await expect(history.locator('summary')).toHaveText('Saved reports (1)', { timeout: 60000 });
  await history.locator('summary').click();
  await history.getByRole('textbox', { name: 'Report name', exact: true }).fill('Architecture check one');
  await history.getByRole('textbox', { name: 'Report name', exact: true }).blur();
  await page.getByRole('button', { name: 'Re-run validation', exact: true }).click();
  await expect(history.locator('summary')).toHaveText('Saved reports (2)', { timeout: 60000 });
  const reports = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().savedValidationReports.map((entry) => ({ id: entry.id, name: entry.name })));
  expect(reports[0].id).not.toBe(reports[1].id);
  await history.getByRole('combobox', { name: 'Select saved validation report', exact: true }).selectOption(reports[0].id);
  await expect(history.getByRole('textbox', { name: 'Report name', exact: true })).toHaveValue('Architecture check one');
  await expect(history.getByText('Models: building-architecture.ifc', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('saved-real-ifc-check-history.png') });

  // A fresh page has neither the live model nor its latest result. Frozen
  // evidence still loads and can be copied to independent document blocks.
  await page.goto(viewerUrl);
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__ !== undefined);
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.upsertDocument({ version: 1, id: 'history-6500', name: 'Saved checks', page: { size: 'A4', orientation: 'portrait' }, blocks: [] });
    state.setActiveDocumentId('history-6500');
    state.openPanelInHome('document');
  });
  const panel = page.locator('[data-document-panel]').first();
  await expect(panel).toBeVisible();
  for (const report of reports) {
    await panel.getByRole('button', { name: 'Add block', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Saved validation report', exact: true }).click();
    await panel.getByRole('combobox', { name: 'Saved report source', exact: true }).last().selectOption(report.id);
  }
  const embedded = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return { models: state.models.size, reports: state.savedValidationReports.length, blocks: state.documents.find((document) => document.id === 'history-6500')?.blocks };
  });
  expect(embedded.models).toBe(0);
  expect(embedded.reports).toBe(2);
  expect(embedded.blocks).toHaveLength(2);
  expect(embedded.blocks?.map((block) => 'savedReportId' in block ? block.savedReportId : undefined)).toEqual(reports.map((report) => report.id));
  await page.screenshot({ path: testInfo.outputPath('saved-checks-document-no-live-model.png') });
});
