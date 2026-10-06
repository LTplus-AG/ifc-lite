/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ViewerBenchmarkPage } from '../benchmark/viewer-benchmark-page';
import { watchGpuDeviceLoss } from './gpu-device-loss';
import { recordViewportWitness } from './viewport-acceptance';

const fixture = join(process.cwd(), 'tests/models/ara3d/AC20-FZK-Haus.ifc');

// #6839: retain the successful coordinator journey for the user's UX review.
// Recorded provider text verifies product behavior, not live LLM quality.
test.use({ video: 'on' });

// #6813: real ArchiCAD model, native duplicate scan and actual panel hosts.
// Only the paid provider response is intercepted; evidence must come from the model.
test('native clash evidence reaches the assistant without executing model output', async ({ page }, testInfo) => {
  test.skip(!existsSync(fixture), 'AC20-FZK-Haus.ifc missing — run pnpm fixtures');
  const gpu = await watchGpuDeviceLoss(page);
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
  // #6858: the footage is geometry acceptance only if the renderer drew the model.
  await recordViewportWitness(page, gpu, testInfo, 'after-load');
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
  await expect(assistant.getByText(/rows attached|The captured native source contains no result rows/).first()).toBeVisible();
  // #6860: the coordinator's default sidebar must fit the refresh action.
  const refresh = assistant.getByRole('button', { name: 'Refresh evidence and start a new conversation', exact: true });
  const panelBounds = await assistant.boundingBox();
  const refreshBounds = await refresh.boundingBox();
  expect(panelBounds).not.toBeNull();
  expect(refreshBounds).not.toBeNull();
  expect(refreshBounds!.x + refreshBounds!.width).toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width + 1);

  // Caveats and the raw snapshot sit behind Evidence details so the conversation leads.
  await assistant.getByText('Evidence details', { exact: true }).click();
  await assistant.getByText('Inspect evidence sent to the model', { exact: true }).click();
  await expect(assistant.locator('pre')).toContainText('AC20-FZK-Haus');
  await expect(assistant.locator('pre')).toContainText('"source":"duplicates"');
  await expect(assistant.locator('pre')).toContainText('"sourceAvailability":"available"');
  await assistant.getByText('Evidence details', { exact: true }).click();
  await assistant.getByLabel('Ask about these results').fill('Explain the native duplicate scan and its limitations.');
  await assistant.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(assistant).toContainText('<script>globalThis.assistantExecuted = true</script>');
  await expect(assistant.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  const completedReply = assistant.locator('[aria-live="polite"] > div').filter({ hasText: '<script>globalThis.assistantExecuted = true</script>' });
  await expect(completedReply).toHaveCount(1);
  await completedReply.scrollIntoViewIfNeeded();
  expect(outbound?.maxOutputTokens).toBe(4096);
  const system = typeof outbound?.system === 'string' ? outbound.system : outbound?.system.map(block => block.text).join('\n');
  expect(system).toContain('AC20-FZK-Haus');
  expect(system).toContain('Frozen native evidence');
  expect(await page.evaluate(() => 'assistantExecuted' in globalThis)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('assistant-context.png') });

  // #6830: reviewed report commits through the native library and keeps the real source.
  await assistant.getByText('Review report draft', { exact: true }).click();
  await assistant.getByLabel('Report name', { exact: true }).fill('ArchiCAD coordination draft');
  await assistant.getByRole('button', { name: 'Prepare report draft', exact: true }).click();
  const saveReport = assistant.getByRole('button', { name: 'Save reviewed document', exact: true });
  await expect(saveReport).toBeDisabled();
  await assistant.getByRole('checkbox', { name: 'I reviewed the narrative, coverage limits and evidence supporting its claims.', exact: true }).check();
  await saveReport.click();
  await expect(assistant).toContainText('Document saved with captured historical evidence');
  expect(await page.evaluate(() => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__: { getState(): {
      documents: Array<{ name: string; blocks: Array<{ kind: string; text?: string }> }>;
    } } }).__ifc_lite_viewer_store__.getState();
    const doc = state.documents.find(candidate => candidate.name === 'ArchiCAD coordination draft');
    return { source: doc?.blocks.some(block => block.text?.includes('AC20-FZK-Haus')),
      historical: doc?.blocks.some(block => block.text?.includes('Captured evidence is historical')),
      literal: doc?.blocks.some(block => block.text?.includes('<script>globalThis.assistantExecuted = true</script>')) };
  })).toEqual({ source: true, historical: true, literal: true });
  expect(await page.evaluate(() => 'assistantExecuted' in globalThis)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('assistant-report.png') });

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
  // A typed patch renders as a proposal card; its review opens beside it without another prompt.
  await expect(assistant).toContainText('Flow patch proposal');
  await expect(assistant.getByRole('region', { name: 'Review Flow changes', exact: true })).toBeVisible();
  await assistant.getByRole('button', { name: 'Review changes', exact: true }).click();
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

  // #6833: discuss actual load diagnostics from the same loaded ArchiCAD file.
  await page.evaluate(() => {
    (globalThis as unknown as { __ifc_lite_viewer_store__: { getState(): { openPanelInHome(panel: 'loadReport'): void } } })
      .__ifc_lite_viewer_store__.getState().openPanelInHome('loadReport');
  });
  await page.getByRole('region', { name: 'Load report', exact: true })
    .getByRole('button', { name: 'Discuss with AI', exact: true }).click();
  await assistant.getByText('Evidence details', { exact: true }).click();
  await assistant.getByText('Inspect evidence sent to the model', { exact: true }).click();
  await expect(assistant.locator('pre')).toContainText('"source":"loadReport"');
  await expect(assistant.locator('pre')).toContainText('AC20-FZK-Haus');
  await expect(assistant.locator('pre')).toContainText('missing diagnostics never mean clean');
  expect(await page.evaluate(() => {
    const pre = document.querySelector('section[aria-label="Assistant"] pre');
    const snapshot = JSON.parse(pre?.textContent ?? '{}') as { evidence: { rows: Array<{ data: {
      diagnosticsAvailable: boolean; diagnostics: { totalCsgFailures: number } | null;
    } }> } };
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__: { getState(): {
      models: Map<string, { diagnostics?: { totalCsgFailures: number } | null }>;
    } } }).__ifc_lite_viewer_store__.getState();
    const native = [...state.models.values()][0].diagnostics ?? null;
    const captured = snapshot.evidence.rows[0].data;
    return captured.diagnosticsAvailable === (native !== null)
      && captured.diagnostics?.totalCsgFailures === native?.totalCsgFailures;
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('assistant-load-report.png') });
  await recordViewportWitness(page, gpu, testInfo, 'final');
});
