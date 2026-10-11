/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ViewerBenchmarkPage } from '../benchmark/viewer-benchmark-page';

const fixture = join(process.cwd(), 'tests/models/ara3d/AC20-FZK-Haus.ifc');

type ClashState = { clashResult: { clashes: Array<{ distance: number }>; summary: { total: number } } | null; clashRunning: boolean };
type Store<S> = { __ifc_lite_viewer_store__: { getState(): S; setState(next: Partial<S>): void } };

type PdfReader = { getDocument(input: { data: Uint8Array; stopAtErrors: boolean; standardFontDataUrl: string }): {
  promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: Array<object> }> }> }>; destroy(): Promise<void> } };

async function pdfText(path: string): Promise<string> {
  // pdf.js is a viewer dependency, so it is resolved from there, with the standard fonts only.
  const require = createRequire(join(process.cwd(), 'apps/viewer/package.json'));
  const reader = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href) as PdfReader;
  const task = reader.getDocument({ data: new Uint8Array(await readFile(path)), stopAtErrors: true,
    standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    pages.push((await page.getTextContent()).items.flatMap(item => 'str' in item && typeof item.str === 'string' ? [item.str] : []).join('\n'));
  }
  await task.destroy();
  return pages.join('\n');
}

// #6918: real ArchiCAD model and native clash run; only the paid provider answer is recorded.
// Its claims are written from the native result, so the checks run against real captured values.
test.use({ viewport: { width: 1600, height: 1000 } });

test('German AI report: checked claims, contradicted claim edit, refresh reconciliation and PDF text', async ({ page }, testInfo) => {
  test.skip(!existsSync(fixture), 'AC20-FZK-Haus.ifc missing — run pnpm fixtures');
  // A returning user: the first-launch privacy notice would cover the screenshots.
  await page.addInitScript(() => window.localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged'));
  const viewer = new ViewerBenchmarkPage(page);
  await viewer.setup();
  await viewer.loadFile(fixture);
  await expect.poll(() => page.evaluate(() => {
    const s = (globalThis as unknown as Store<{ models: Map<string, unknown>; loading: boolean; geometryStreamingActive: boolean }>).__ifc_lite_viewer_store__.getState();
    return s.models.size === 1 && !s.loading && !s.geometryStreamingActive;
  }), { timeout: 120_000 }).toBe(true);
  await page.evaluate(() => (globalThis as unknown as Store<{ openPanelInHome(panel: 'clash'): void }>).__ifc_lite_viewer_store__.getState().openPanelInHome('clash'));
  await page.getByRole('button', { name: 'Detect all clashes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const s = (globalThis as unknown as Store<ClashState>).__ifc_lite_viewer_store__.getState();
    return !!s.clashResult && !s.clashRunning;
  }), { timeout: 180_000 }).toBe(true);
  const native = await page.evaluate(() => {
    const { clashResult } = (globalThis as unknown as Store<ClashState>).__ifc_lite_viewer_store__.getState();
    return { first: clashResult!.clashes[0].distance, second: clashResult!.clashes[1].distance, total: clashResult!.summary.total };
  });
  // Rounded to one decimal and sent as a string, the only way a claim may state a rounded value.
  const firstMm = (native.first * 1000).toFixed(1);
  const answer = ['## Zusammenfassung', `Die Prüfung ergab ${native.total} Kollisionen; Wände und Decken überschneiden sich [E1].`, '',
    '```json', JSON.stringify({ version: 1, kind: 'report.claims', language: 'de', claims: [
      { text: `E1 überlappt um ${firstMm} mm.`, facts: [{ citation: 'E1', field: 'distance', value: firstMm, unit: 'mm' }] },
      { text: 'E2 überlappt um 999 mm.', facts: [{ citation: 'E2', field: 'distance', value: -999, unit: 'mm' }] },
      { text: `Insgesamt ${native.total} Kollisionen.`, facts: [{ citation: 'summary', field: 'total', value: native.total }] },
    ] }), '```'].join('\n');
  let prompt = '';
  await page.route('**/api/chat', async route => {
    prompt = (route.request().postDataJSON() as { messages: Array<{ content: string }> }).messages.at(-1)?.content ?? '';
    await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n` });
  });
  // Local builds may ship without a configured default model; the recorded answer is the same either way.
  await page.evaluate(() => (globalThis as unknown as Store<{ chatActiveModel: string }>).__ifc_lite_viewer_store__.setState({ chatActiveModel: 'openai/gpt-free' }));
  await page.getByRole('button', { name: 'Discuss with AI', exact: true }).click();
  const assistant = page.getByRole('region', { name: 'Assistant', exact: true });
  await assistant.getByText('Review report draft', { exact: true }).click();
  await assistant.getByLabel('Narrative language', { exact: true }).selectOption('de');
  await assistant.getByRole('button', { name: 'Draft report with AI', exact: true }).click();
  await expect(assistant).toContainText('Insgesamt');
  expect(prompt).toContain('German (de)');
  await assistant.getByLabel('Report name', { exact: true }).fill('Koordinationsbericht');
  await assistant.getByRole('button', { name: 'Prepare report draft', exact: true }).click();
  const claims = assistant.getByRole('region', { name: 'Claims checked against captured evidence', exact: true });
  await expect(claims.locator('[data-claim="C1"]')).toContainText('Supported by data');
  await expect(claims.locator('[data-claim="C2"]')).toContainText('Contradicted');
  await expect(claims.locator('[data-claim="C3"]')).toContainText('Supported by data');
  await expect(claims.getByRole('alert')).toContainText('1 claim contradicts the captured evidence');
  await claims.locator('[data-claim="C2"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('report-claims-contradicted.png') });
  await claims.screenshot({ path: testInfo.outputPath('report-claims-list.png') });
  const approval = assistant.getByRole('checkbox', { name: 'I reviewed the narrative, coverage limits and evidence supporting its claims.', exact: true });
  await approval.check();
  await expect(assistant.getByRole('button', { name: 'Save reviewed document', exact: true })).toBeDisabled();
  await claims.locator('[data-claim="C2"]').getByRole('button', { name: 'Edit claim', exact: true }).click();
  await claims.getByLabel('Claim text', { exact: true }).fill('E2 ist eine weitere harte Kollision.');
  await claims.getByRole('button', { name: 'Use edited text', exact: true }).click();
  await expect(claims.locator('[data-claim="C2"]')).toContainText('Unverifiable');
  await expect(claims.getByRole('alert')).toHaveCount(0);
  await approval.check();
  await assistant.getByRole('button', { name: 'Save reviewed document', exact: true }).click();
  await expect(assistant).toContainText('Document saved with captured historical evidence');
  await page.screenshot({ path: testInfo.outputPath('report-claims-saved.png') });

  await assistant.getByRole('button', { name: 'Open document', exact: true }).click();
  // The bottom strip is short at this size; maximize it so the review is legible in the screenshots.
  await page.getByRole('button', { name: 'Maximize', exact: true }).click();
  const refresh = page.getByRole('region', { name: 'Refresh evidence', exact: true });
  await expect(refresh).toContainText('AI report · German · revision 1');
  await expect(page.locator('[data-ai-origin="ai-generated"]').first()).toBeVisible();
  // A person rewrites the first claim's caption; the next native run deepens that clash by 5 mm.
  const blockTexts = page.locator('[data-document-blocks] textarea');
  const withValue = (match: string) => blockTexts.evaluateAll((list, text) => list.filter(el => (el as HTMLTextAreaElement).value.includes(text)).length, match);
  // #7302: generated report chrome follows the saved German report, independently of UI locale.
  const captionIndex = await blockTexts.evaluateAll(list => list.findIndex(el => (el as HTMLTextAreaElement).value.startsWith('Durch erfasste Daten unterstützt · Quellen: E1\n')));
  expect(captionIndex).toBeGreaterThanOrEqual(0);
  // The claim rewritten during review is already edited text; the caption is the second edit.
  await expect(page.locator('[data-ai-origin="human-edited"]')).toHaveCount(1);
  await blockTexts.nth(captionIndex).fill('Vor Ort geprüft: Durchbruch fehlt.');
  await expect(page.locator('[data-ai-origin="human-edited"]')).toHaveCount(2);
  await page.evaluate(() => {
    const store = (globalThis as unknown as Store<ClashState>).__ifc_lite_viewer_store__;
    const result = store.getState().clashResult!;
    const clashes = result.clashes.map((clash, index) => index === 0 ? { ...clash, distance: clash.distance - 0.005 } : clash);
    store.setState({ clashResult: { ...result, clashes } });
  });
  await refresh.getByRole('button', { name: 'Refresh evidence', exact: true }).click();
  await expect(refresh).toContainText('C1: Supported by data → Contradicted; 1 changed, 0 missing');
  await expect(refresh.locator('[data-conflict="claim-facts:C1"]')).toContainText('Vor Ort geprüft: Durchbruch fehlt.');
  await refresh.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('report-refresh-conflict.png') });
  await refresh.screenshot({ path: testInfo.outputPath('report-refresh-section.png') });
  await refresh.getByRole('button', { name: 'Apply refresh', exact: true }).click();
  await expect(refresh.getByRole('status')).toContainText('Evidence refreshed');
  await expect(refresh).toContainText('revision 2');
  expect(await withValue('Vor Ort geprüft: Durchbruch fehlt.')).toBe(1);
  expect(await withValue('Nachweise aktualisiert (Revision 2): 1 zitierte Werte geändert')).toBe(1);
  await page.locator('[data-ai-origin="human-edited"]').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('report-refresh-applied.png') });

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  const file = testInfo.outputPath('koordinationsbericht.pdf');
  await (await download).saveAs(file);
  const text = await pdfText(file);
  expect(text).toContain('Wände und Decken überschneiden sich [E1].');
  expect(text).toContain('Vor Ort geprüft: Durchbruch fehlt.');
  expect(text).toContain('Berichtssprache: de · Revision 2');
  expect(text).toMatch(/Nachweise aktualisiert \(Revision 2\): 1 zitierte Werte geändert/);
});
