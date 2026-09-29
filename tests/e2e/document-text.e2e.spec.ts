/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test, expect } from '@playwright/test';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { contrastOfTextOnSurface, WCAG_AA_NORMAL_TEXT } from '../../apps/viewer/src/test/contrast/wcag';
import { inflateSync } from 'node:zlib';
import { IfcTypeEnum } from '../../packages/data/src/index';

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
  await page.setViewportSize({ width: 1600, height: 1000 });
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
  // Record a manual review against the same genuinely loaded IFC through the
  // canonical checklist actions and the real Save report button.
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()].find((entry) => entry.name === 'building-architecture.ifc');
    if (!model?.sourceFingerprint) throw new Error('Loaded IFC has no source identity');
    state.newManualChecklist();
    state.renameManualChecklist('Architecture coordination review');
    const group = state.addManualGroup('Delivery');
    const item = group && state.addManualItem(group, 'Confirm model origin');
    if (!item) throw new Error('Checklist item could not be created');
    state.setManualAnswer(model.sourceFingerprint, item, { status: 'warning', comment: 'Confirm survey origin' });
  });
  await page.getByRole('tab', { name: 'Manual validation', exact: true }).click();
  await page.getByRole('button', { name: 'Save report', exact: true }).click();
  await expect(history.locator('summary')).toHaveText('Saved reports (3)');
  const reports = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().savedValidationReports.map((entry) => ({ id: entry.id, name: entry.name })));
  expect(reports[0].id).not.toBe(reports[1].id);
  await history.getByRole('combobox', { name: 'Select saved validation report', exact: true }).selectOption(reports[0].id);
  await expect(history.getByRole('textbox', { name: 'Report name', exact: true })).toHaveValue('Architecture check one');
  await expect(history.getByText('Models: building-architecture.ifc', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('saved-real-ifc-check-history.png') });

  // A live report remembers evaluated scope even if its current model is
  // renamed after validation. Both Add and Refresh use that captured evidence.
  await page.evaluate(async () => {
    const moduleUrl = '/src/lib/document/presets.ts';
    const { blankDocument }: typeof import('../../apps/viewer/src/lib/document/presets') = await import(moduleUrl);
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()].find(entry => entry.name === 'building-architecture.ifc');
    if (!model) throw new Error('Real validated model missing');
    state.setModelName(model.id, 'Renamed after evaluation.ifc');
    const document = { ...blankDocument(), name: 'Live evaluated scope', blocks: [] };
    state.upsertDocument(document);
    state.setActiveDocumentId(document.id);
    state.openPanelInHome('document');
  });
  const livePanel = page.locator('[data-document-panel]').first();
  await livePanel.getByRole('button', { name: 'Add block', exact: true }).click();
  await page.getByRole('menuitem', { name: 'IDS validation report', exact: true }).click();
  await expect(livePanel.locator('[data-report-model-scope]')).toHaveText('Models: building-architecture.ifc');
  await livePanel.getByRole('button', { name: 'Refresh from current validation report', exact: true }).click();
  await expect(livePanel.locator('[data-report-model-scope]')).toHaveText('Models: building-architecture.ifc');
  await page.screenshot({ path: testInfo.outputPath('live-evaluated-scope-after-model-rename.png') });

  // A fresh page has neither the live model nor its latest result. Frozen
  // evidence still loads and can be copied to independent document blocks.
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setManualChecklist(null));
  await page.goto(viewerUrl);
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__ !== undefined);
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.upsertDocument({ version: 8, id: 'history-6500', name: 'Saved checks', page: { size: 'A4', orientation: 'portrait' }, blocks: [] });
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
  const layouts = panel.getByRole('combobox', { name: 'IDS report layout', exact: true });
  await expect(layouts).toHaveCount(2);
  await expect(layouts.first()).toHaveValue('');
  await layouts.first().selectOption('compact');
  await layouts.last().selectOption('long');
  await panel.getByRole('combobox', { name: 'Saved report source', exact: true }).first().selectOption(reports[1].id);
  await expect(layouts.first()).toHaveValue('compact');
  await panel.getByRole('combobox', { name: 'Saved report source', exact: true }).first().selectOption(reports[0].id);
  await expect(panel.locator('[data-ids-report-variant="compact"]')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Refresh from current validation report', exact: true })).toHaveCount(0);
  const embedded = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return { models: state.models.size, reports: state.savedValidationReports.length, blocks: state.documents.find((document) => document.id === 'history-6500')?.blocks };
  });
  expect(embedded.models).toBe(0);
  expect(embedded.reports).toBe(3);
  expect(embedded.blocks).toHaveLength(3);
  expect(embedded.blocks?.map((block) => 'savedReportId' in block ? block.savedReportId : undefined)).toEqual(reports.map((report) => report.id));
  expect(embedded.blocks?.map((block) => block.kind)).toEqual(['ids-report', 'ids-report', 'manual-report']);
  await page.screenshot({ path: testInfo.outputPath('saved-checks-document-no-live-model.png') });
  await page.getByRole('button', { name: 'Maximize', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: 'Saved report source', exact: true })).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath('saved-checks-document-maximized.png') });
  const downloadPromise = page.waitForEvent('download');
  await panel.locator('[data-document-export]').click();
  const download = await downloadPromise;
  await download.saveAs(testInfo.outputPath('saved-checks-document.pdf'));
  const { readFile } = await import('node:fs/promises');
  const bytes = Array.from(await readFile(testInfo.outputPath('saved-checks-document.pdf')));
  const text = await page.evaluate(async (bytes) => {
    const moduleUrl = '/src/lib/llm/document-text.ts';
    const documentText: typeof import('../../apps/viewer/src/lib/llm/document-text') = await import(moduleUrl);
    return documentText.extractPdfText(new Blob([new Uint8Array(bytes)]));
  }, bytes);
  expect(text).toContain('building-architecture.ifc');
  expect(text).toContain('Architecture coordination review');
  expect(text).toContain('Confirm survey origin');
});

test('#6506 three real model pairs survive reload and export the selected saved comparison', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1680, height: 1050 });
  const settle = async (count: number) => page.waitForFunction((n) => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state && state.models.size === n && !state.loading && !state.geometryStreamingActive;
  }, count, { timeout: 120000 });
  const openCompare = async () => {
    await page.getByRole('tab', { name: 'Analyze', exact: true }).click();
    await page.getByRole('button', { name: /^Compare/ }).first().click();
    await expect(page.locator('[data-saved-comparisons]')).toBeVisible();
  };
  await page.goto(`${viewerUrl}?model=/samples/building-architecture.ifc`);
  await settle(1);
  // The revision is derived from the actual SketchUp-exported architecture;
  // the independent bridge exercises retaining more than one model pair.
  for (const filename of ['building-architecture-rev-b.ifc', 'infra-bridge.ifc']) {
    await page.evaluate(async (filename) => {
      const previous = globalThis.__ifc_lite_viewer_store__.getState().models.size;
      const response = await fetch(`/samples/${filename}`);
      if (!response.ok) throw new Error(`Sample fetch failed: ${filename}`);
      window.dispatchEvent(new CustomEvent('ifc-lite:add-model', {
        detail: new File([await response.blob()], filename, { type: 'application/x-step' }),
      }));
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Model load did not settle')); }, 120000);
        const unsubscribe = globalThis.__ifc_lite_viewer_store__.subscribe((state) => {
          if (state.models.size === previous + 1 && !state.loading && !state.geometryStreamingActive) {
            clearTimeout(timeout); unsubscribe(); resolve();
          }
        });
      });
    }, filename);
  }
  await settle(3);
  const models = await page.evaluate(() => [...globalThis.__ifc_lite_viewer_store__.getState().models.values()].map(({ id, name }) => ({ id, name })));
  await openCompare();
  for (const [base, head, name] of [[0, 1, 'Architecture A/B'], [0, 2, 'Architecture A / Bridge C'], [1, 2, 'Architecture B / Bridge C']] as const) {
    await page.getByRole('combobox', { name: 'A', exact: true }).selectOption(models[base].id);
    await page.getByRole('combobox', { name: 'B', exact: true }).selectOption(models[head].id);
    await page.getByRole('button', { name: 'Data', exact: true }).click();
    const previous = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().compareRunSeq);
    await page.getByRole('button', { name: 'Run comparison', exact: true }).click();
    await page.waitForFunction((sequence) => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      return !state.compareRunning && state.compareResult && state.compareRunSeq > sequence;
    }, previous);
    await page.getByRole('textbox', { name: 'Comparison name', exact: true }).fill(name);
    await page.getByRole('button', { name: 'Save comparison', exact: true }).click();
  }
  const history = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().savedComparisons);
  expect(history).toHaveLength(3);
  expect(history.map(({ pair }) => [pair.baseModelId, pair.headModelId])).toEqual([
    [models[0].id, models[1].id], [models[0].id, models[2].id], [models[1].id, models[2].id],
  ]);
  expect(history[0].report.counts).toMatchObject({ added: 1, deleted: 1, modified: 1 });
  expect(history.map(({ report }) => report.rows.length)).toEqual([3, 95, 95]);
  await page.getByRole('combobox', { name: 'Saved comparison', exact: true }).selectOption(history[0].id);
  await page.locator('[data-saved-comparisons]').screenshot({ path: testInfo.outputPath('saved-model-comparison-history.png') });
  // Only A is loaded after a fresh page; historical B/C results remain portable.
  await page.reload(); await settle(1); await openCompare();
  await page.getByRole('combobox', { name: 'Saved comparison', exact: true }).selectOption(history[1].id);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().savedComparisons)).toEqual(history);
  await page.getByRole('button', { name: /^Document/ }).first().click();
  const panel = page.locator('[data-document-panel]');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Add block', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Saved comparison', exact: true }).click();
  await panel.getByRole('combobox', { name: 'Choose saved comparison for document' }).selectOption(history[0].id);
  const embedded = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return state.documents.find(({ id }) => id === state.activeDocumentId)?.blocks.find((block) => block.kind === 'table' && block.source.kind === 'comparison');
  });
  expect(embedded?.kind === 'table' && embedded.source.kind === 'comparison' ? embedded.source.comparison : undefined).toEqual(history[0]);
  await page.getByRole('button', { name: 'Maximize', exact: true }).click();
  await panel.getByRole('combobox', { name: 'Choose saved comparison for document' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('saved-model-comparison-document.png') });
  const downloadPromise = page.waitForEvent('download');
  await panel.locator('[data-document-export]').click();
  const pdfPath = testInfo.outputPath('saved-model-comparison-document.pdf');
  await (await downloadPromise).saveAs(pdfPath);
  const { readFile } = await import('node:fs/promises');
  const bytes = Array.from(await readFile(pdfPath));
  const text = await page.evaluate(async (bytes) => {
    const moduleUrl = '/src/lib/llm/document-text.ts';
    const documentText: typeof import('../../apps/viewer/src/lib/llm/document-text') = await import(moduleUrl);
    return documentText.extractPdfText(new Blob([new Uint8Array(bytes)]));
  }, bytes);
  expect(text).toContain('Architecture A/B');
  expect(text).toContain(models[0].name);
  expect(text).toContain(models[1].name);
  // Existing table layout ellipsizes narrow cells; the portable snapshot above
  // retains complete identifiers while the real PDF must contain every row.
  for (const row of history[0].report.rows) {
    expect(text).toContain(row.globalId.slice(0, 10));
    expect(text).toContain(row.name.slice(0, 10));
  }
  expect(text).not.toContain('Architecture B / Bridge C');
  // Real persisted reports plus damaged/duplicate neighbours must remain
  // visible after the production store's next initial read, with an explicit
  // recovery notice and the complete original bytes safely archived.
  const damagedHistory = JSON.stringify([...history, null, history[0]]);
  await page.evaluate((raw) => localStorage.setItem('ifc-lite-saved-comparisons', raw), damagedHistory);
  await page.reload(); await settle(1); await openCompare();
  const library = page.locator('[data-saved-comparisons]');
  await expect(library.getByRole('alert')).toContainText('The original data was preserved');
  const noticeColors = await library.getByRole('alert').evaluate((notice) => {
    let surface: Element | null = notice;
    while (surface) {
      const background = getComputedStyle(surface).backgroundColor;
      if (background.startsWith('rgb(')) {
        return { foreground: getComputedStyle(notice).color, background };
      }
      surface = surface.parentElement;
    }
    throw new Error('Recovered comparison notice has no opaque surface');
  });
  const noticeContrast = contrastOfTextOnSurface(noticeColors.foreground, noticeColors.background);
  expect(noticeContrast).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  const contrastPath = testInfo.outputPath('saved-model-comparison-recovery-contrast.json');
  await writeFile(contrastPath, JSON.stringify({ ...noticeColors, contrast: noticeContrast }, null, 2));
  await testInfo.attach('recovered-history-contrast', {
    path: contrastPath, contentType: 'application/json',
  });
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().savedComparisons)).toEqual(history);
  expect(await page.evaluate(() => localStorage.getItem('ifc-lite-saved-comparisons:unreadable'))).toBe(damagedHistory);
  await page.getByRole('combobox', { name: 'Saved comparison', exact: true }).selectOption(history[0].id);
  await library.screenshot({ path: testInfo.outputPath('saved-model-comparison-recovery.png') });
});

test('#6489 real IFC document tables retain independent ordering and coloured repeated PDF headers', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1680, height: 1050 });
  const settle = async (count: number) => page.waitForFunction((n) => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state && state.models.size === n && !state.loading && !state.geometryStreamingActive;
  }, count, { timeout: 120000 });
  await page.goto(`${viewerUrl}?model=/samples/building-architecture.ifc`);
  await settle(1);
  await page.evaluate(async () => {
    const response = await fetch('/samples/infra-bridge.ifc');
    if (!response.ok) throw new Error('Bridge sample fetch failed');
    window.dispatchEvent(new CustomEvent('ifc-lite:add-model', {
      detail: new File([await response.blob()], 'infra-bridge.ifc', { type: 'application/x-step' }),
    }));
  });
  await settle(2);
  await page.evaluate((entityTypes) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const list = { id: 'ifc-products-6489', name: 'IFC products', createdAt: 1, updatedAt: 1, entityTypes, groups: [],
      columns: [{ id: 'class', source: 'attribute' as const, propertyName: 'Class' }, { id: 'name', source: 'attribute' as const, propertyName: 'Name' }],
      grouping: { columnId: 'class', sumColumnIds: [] } };
    state.upsertDocument({ version: 9, id: 'table-options-6489', name: 'IFC table options', page: { size: 'A4', orientation: 'portrait' },
      blocks: [{ kind: 'table', id: 'largest', source: { kind: 'list', list }, title: 'Largest first', maxRows: 500 },
        { kind: 'table', id: 'labels', source: { kind: 'list', list: { ...list, id: 'copy-6489' } }, title: 'By label', maxRows: 500 }] });
    state.setActiveDocumentId('table-options-6489'); state.showWorkspacePanel('document');
  }, [IfcTypeEnum.IfcWall, IfcTypeEnum.IfcBuildingElementProxy, IfcTypeEnum.IfcFurniture, IfcTypeEnum.IfcBeam]);
  const panel = page.locator('[data-document-panel]:visible');
  await expect(panel).toHaveCount(1);
  await expect(panel.locator('[data-block-table] table')).toHaveCount(2);
  await page.getByRole('button', { name: 'Maximize', exact: true }).click();
  const editor = panel.locator('[data-block-editor="labels"]');
  const preview = panel.locator('[data-preview-block="labels"]');
  const firstPreview = panel.locator('[data-preview-block="largest"]');
  const largest = ['IfcBuildingElementProxy  (14)', 'IfcBeam  (8)', 'IfcWall  (8)', 'IfcFurniture  (1)'];
  const alphabetic = ['IfcBeam  (8)', 'IfcBuildingElementProxy  (14)', 'IfcFurniture  (1)', 'IfcWall  (8)'];
  await expect(firstPreview.locator('tr[data-role="group"] td:first-child')).toHaveText(largest);
  await editor.getByRole('combobox', { name: 'Group order', exact: true }).selectOption('label');
  await expect(preview.locator('tr[data-role="group"] td:first-child')).toHaveText(alphabetic);
  await expect(firstPreview.locator('tr[data-role="group"] td:first-child')).toHaveText(largest);
  const color = editor.locator('input[aria-label="Header background"]');
  await color.fill('#332244');
  await expect(preview.locator('th').first()).toHaveCSS('color', 'rgb(255, 255, 255)');
  await editor.getByRole('button', { name: 'Reset table header background', exact: true }).click();
  await expect(preview.locator('th').first()).toHaveCSS('background-color', 'rgb(51, 65, 85)');
  await color.fill('#ffee88');
  await expect(preview.locator('th').first()).toHaveCSS('background-color', 'rgb(255, 238, 136)');
  await expect(preview.locator('th').first()).toHaveCSS('color', 'rgb(0, 0, 0)');
  await preview.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('document-table-options.png') });
  const downloadPromise = page.waitForEvent('download'); await panel.locator('[data-document-export]').click();
  const pdfPath = testInfo.outputPath('document-table-options.pdf');
  await (await downloadPromise).saveAs(pdfPath);
  const { readFile } = await import('node:fs/promises');
  const pdf = await readFile(pdfPath);
  const text = await page.evaluate(async (bytes) => {
    const moduleUrl = '/src/lib/llm/document-text.ts';
    const documentText: typeof import('../../apps/viewer/src/lib/llm/document-text') = await import(moduleUrl);
    return documentText.extractPdfText(new Blob([new Uint8Array(bytes)]));
  }, Array.from(pdf));
  expect(text).toContain('[Page 2]');
  const normalized = text.replace(/\s+/g, ' ');
  const orderedText = normalized.slice(normalized.indexOf('By label'));
  const positions = alphabetic.map((label) => orderedText.indexOf(label.replace(/\s+/g, ' ')));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  // Inspect actual emitted page-stream fill colours, including Flate streams.
  // At least two pages must carry the custom header; a recording seam alone
  // would not catch a browser adapter that silently retained its default.
  const streams: string[] = [];
  for (const match of pdf.toString('latin1').matchAll(/<<([^<>]*)>>\s*stream\r?\n/g)) {
    const length = Number(match[1].match(/\/Length\s+(\d+)\b/)?.[1]);
    if (!Number.isSafeInteger(length) || length < 0) continue;
    const start = match.index + match[0].length;
    expect(start + length).toBeLessThanOrEqual(pdf.length);
    const bytes = pdf.subarray(start, start + length);
    streams.push((match[1].includes('/FlateDecode') ? inflateSync(bytes, { maxOutputLength: 1024 * 1024 }) : bytes).toString('latin1'));
  }
  const number = '(-?\\d+(?:\\.\\d*)?)';
  const customPages = streams.filter((stream) => [...stream.matchAll(new RegExp(`${number}\\s+${number}\\s+${number}\\s+rg`, 'g'))]
    .some((match) => [1, 238 / 255, 136 / 255].every((channel, index) => Math.abs(Number(match[index + 1]) - channel) < 0.01)));
  expect(customPages.length).toBeGreaterThanOrEqual(2);
  await page.reload(); await settle(1);
  await page.getByRole('tab', { name: 'Analyze', exact: true }).click();
  await page.getByRole('button', { name: /^Document/ }).first().click();
  const restored = page.locator('[data-block-editor="labels"]');
  await expect(restored.getByRole('combobox', { name: 'Group order', exact: true })).toHaveValue('label');
  await expect(restored.locator('input[aria-label="Header background"]')).toHaveValue('#ffee88');
});
