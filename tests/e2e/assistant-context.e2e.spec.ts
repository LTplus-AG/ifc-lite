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
      getState(): { ifcDataStore: { entityCount: number } | null; models: Map<string, unknown>; loading: boolean; geometryStreamingActive: boolean };
    } }).__ifc_lite_viewer_store__;
    const state = store?.getState();
    return state?.models.size === 1 && !state.loading && !state.geometryStreamingActive
      && (state.ifcDataStore?.entityCount ?? 0) > 100;
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
  type Outbound = { system: string | Array<{ text: string }>; maxOutputTokens: number };
  let outbound: Outbound | undefined;
  await page.route('**/api/chat', async route => {
    outbound = route.request().postDataJSON() as Outbound;
    const request = route.request().postDataJSON() as { messages: Array<{ content: string }> };
    const flowDraft = request.messages.at(-1)?.content.includes('Draft a Flow patch');
    const content = flowDraft ? JSON.stringify({ version: 1, kind: 'flow.patch', operations: [
      { op: 'addNode', alias: 'wall-query', type: 'model.byType', pos: [0, 0] },
      { op: 'setParam', node: 'wall-query', param: 'type', value: 'IfcWall' },
    ] }) : '<script>globalThis.assistantExecuted = true</script> Review native duplicate settings.';
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
  const system = typeof outbound?.system === 'string' ? outbound.system : outbound?.system.map(block => block.text).join('\n');
  expect(system).toContain('AC20-FZK-Haus');
  expect(system).toContain('Frozen native evidence');
  expect(await page.evaluate(() => 'assistantExecuted' in globalThis)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('assistant-context.png') });

  // #6822: real native Flow toolbar -> draft -> reviewed graph effect, still no Run.
  await page.evaluate(() => {
    const store = (globalThis as unknown as { __ifc_lite_viewer_store__: {
      getState(): { createFlow(name: string): string | null; openPanelInHome(panel: 'flow'): void };
    } }).__ifc_lite_viewer_store__;
    if (!store.getState().createFlow('AI coordination workflow')) throw new Error('Native Flow creation refused');
    store.getState().openPanelInHome('flow');
  });
  await page.getByRole('button', { name: 'Discuss with AI', exact: true }).click();
  await assistant.getByLabel('Ask about these results').fill('Draft a Flow patch to select IfcWall elements.');
  await assistant.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(assistant).toContainText('wall-query');
  await assistant.getByText('Review Flow changes', { exact: true }).click();
  await assistant.getByRole('button', { name: 'Review latest Flow answer', exact: true }).click();
  await expect(assistant).toContainText('Additional graph capabilities: model.read');
  const apply = assistant.getByRole('button', { name: 'Apply graph changes', exact: true });
  await expect(apply).toBeDisabled();
  await assistant.getByRole('checkbox', { name: 'I reviewed the graph changes, tracking effects and additional capabilities.', exact: true }).check();
  await apply.click();
  await expect(assistant).toContainText('No graph execution or model edits were performed');
  expect(await page.evaluate(() => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__: { getState(): {
      flowDoc: { nodes: Array<{ type: string; params?: { type?: string } }> }; flowLastRun: unknown;
    } } }).__ifc_lite_viewer_store__.getState();
    return { nodes: state.flowDoc.nodes, lastRun: state.flowLastRun };
  })).toEqual({ nodes: [{ id: 'byType-1', type: 'model.byType', pos: [0, 0], params: { type: 'IfcWall' } }], lastRun: null });
  await page.screenshot({ path: testInfo.outputPath('assistant-flow.png') });
  await assistant.getByRole('button', { name: 'Undo graph changes', exact: true }).click();
});
