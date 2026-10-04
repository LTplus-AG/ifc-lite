/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ViewerBenchmarkPage } from '../benchmark/viewer-benchmark-page';

const fixture = join(process.cwd(), 'tests/models/ara3d/AC20-FZK-Haus.ifc');

// #6813: real ArchiCAD model, native duplicate scan and actual panel hosts.
// Only the paid provider response is intercepted; evidence must come from the model.
test('native clash evidence reaches the assistant without executing model output', async ({ page }, testInfo) => {
  test.skip(!existsSync(fixture), 'AC20-FZK-Haus.ifc missing — run pnpm fixtures');
  const viewer = new ViewerBenchmarkPage(page);
  await viewer.setup();
  await viewer.loadFile(fixture);
  await expect.poll(() => page.evaluate(() => {
    const store = (globalThis as unknown as { __ifc_lite_viewer_store__?: {
      getState(): { ifcDataStore: { entityCount: number } | null; models: Map<string, unknown> };
    } }).__ifc_lite_viewer_store__;
    const state = store?.getState();
    return state?.models.size === 1 && (state.ifcDataStore?.entityCount ?? 0) > 100;
  }), { timeout: 120_000 }).toBe(true);
  await page.evaluate(() => {
    const store = (globalThis as unknown as { __ifc_lite_viewer_store__: {
      getState(): { openPanelInHome(panel: 'clash'): void };
    } }).__ifc_lite_viewer_store__;
    store.getState().openPanelInHome('clash');
  });
  await page.getByRole('button', { name: 'Find duplicates', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const store = (globalThis as unknown as { __ifc_lite_viewer_store__: {
      getState(): { clashResult: unknown; clashRunning: boolean };
    } }).__ifc_lite_viewer_store__;
    const state = store.getState();
    return state.clashResult !== null && !state.clashRunning;
  }), { timeout: 120_000 }).toBe(true);
  let outbound: { system: string; maxOutputTokens: number } | undefined;
  await page.route('**/api/chat', async route => {
    outbound = route.request().postDataJSON() as { system: string; maxOutputTokens: number };
    const content = '<script>globalThis.assistantExecuted = true</script> Review native duplicate settings.';
    await route.fulfill({ contentType: 'text/event-stream', body:
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n` });
  });
  await page.getByRole('button', { name: 'Discuss with AI', exact: true }).click();
  const assistant = page.getByRole('region', { name: 'Assistant', exact: true });
  await expect(assistant.getByText(/Frozen evidence:/)).toBeVisible();
  await assistant.getByText('Inspect evidence sent to the model', { exact: true }).click();
  await expect(assistant.locator('pre')).toContainText('AC20-FZK-Haus');
  await expect(assistant.locator('pre')).toContainText('"source":"clash"');
  await assistant.getByText('Inspect evidence sent to the model', { exact: true }).click();
  await assistant.getByLabel('Ask about these results').fill('Explain the native duplicate scan and its limitations.');
  await assistant.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(assistant).toContainText('<script>globalThis.assistantExecuted = true</script>');
  expect(outbound?.maxOutputTokens).toBe(4096);
  expect(outbound?.system).toContain('AC20-FZK-Haus');
  expect(outbound?.system).toContain('Frozen native evidence');
  expect(await page.evaluate(() => 'assistantExecuted' in globalThis)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('assistant-context.png') });
});
