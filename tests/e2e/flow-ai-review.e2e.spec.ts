/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6923: the shipped "AI wall roles (reviewed)" example on the committed
 * `building-architecture.ifc` sample through the real Flow panel. Run →
 * the AI node's proposal pauses the run (nothing written) → the checkpoint
 * survives a page reload → Approve resumes from it without a new model
 * request and writes the approved labels → a second run is rejected and
 * nothing downstream runs. Only the provider response is recorded, computed
 * from the rows the viewer actually sent through the hosted proxy route.
 */

import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { ViewerBenchmarkPage } from '../benchmark/viewer-benchmark-page';

test.use({ viewport: { width: 1600, height: 1000 } });

const fixture = join(process.cwd(), 'apps/viewer/public/samples/building-architecture.ifc');

type Report = { nodeId: string; status: string };
type Store = { getState(): {
  models: Map<string, unknown>; loading: boolean; geometryStreamingActive: boolean; ifcDataStore: { entityCount: number } | null;
  flowRunning: boolean; flowDoc: { id: string; name: string } | null;
  flowLastRun: { ok: boolean; writes: number; reports: Report[]; graphOutputs: Array<{ label: string; data?: { kind: string; items?: unknown[] } }> } | null;
  flowLastError: string | null;
  editEnabled: boolean; setEditEnabled?: (on: boolean) => void; setChatActiveModel(model: string): void;
  openPanelInHome(panel: string): void;
} };
const state = (page: Page) => page.evaluate(() => {
  const s = (globalThis as unknown as { __ifc_lite_viewer_store__: Store }).__ifc_lite_viewer_store__.getState();
  return {
    ready: s.models.size === 1 && !s.loading && !s.geometryStreamingActive && (s.ifcDataStore?.entityCount ?? 0) > 100,
    running: s.flowRunning, flow: s.flowDoc ? { id: s.flowDoc.id, name: s.flowDoc.name } : null, error: s.flowLastError,
    run: s.flowLastRun ? {
      ok: s.flowLastRun.ok, writes: s.flowLastRun.writes,
      statuses: Object.fromEntries(s.flowLastRun.reports.map((r) => [r.nodeId, r.status])),
      written: s.flowLastRun.graphOutputs.find((o) => o.label === 'Walls written')?.data?.items?.length ?? null,
    } : null,
  };
});
const settled = async (page: Page) => {
  await expect.poll(async () => { const s = await state(page); return s.run !== null && !s.running; }, { timeout: 60_000 }).toBe(true);
  return (await state(page)).run!;
};

async function openSample(page: Page): Promise<void> {
  const viewer = new ViewerBenchmarkPage(page);
  await viewer.setup();
  await viewer.loadFile(fixture);
  await expect.poll(async () => (await state(page)).ready, { timeout: 120_000 }).toBe(true);
  await page.evaluate(() => {
    const s = (globalThis as unknown as { __ifc_lite_viewer_store__: Store }).__ifc_lite_viewer_store__.getState();
    s.setChatActiveModel('openai/gpt-4o-mini');
    if (!s.editEnabled) s.setEditEnabled?.(true);
    s.openPanelInHome('flow');
  });
  // Room for the canvas and the review card in the screenshots.
  await page.getByRole('button', { name: 'Maximize', exact: true }).click();
}

test('#6923 a Flow AI proposal pauses the run, survives a reload, and only an approval resumes it', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e'));
  const sent: string[] = [];
  await page.route('**/api/chat', async (route) => {
    const body = route.request().postDataJSON() as { messages: Array<{ content: string }> };
    const prompt = body.messages.at(-1)?.content ?? '';
    sent.push(prompt);
    const rows = (/<data>\n([\s\S]*)\n<\/data>/.exec(prompt)?.[1] ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const items = rows.map((r) => ({ key: r.key, label: (r.values as Record<string, unknown>)['Pset_WallCommon.IsExternal'] === true ? 'Facade' : 'Partition', evidence: ['Pset_WallCommon.IsExternal'] }));
    await route.fulfill({ contentType: 'text/event-stream', body:
      `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ items }) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
  });
  await openSample(page);
  const panel = page.locator('[data-flow-panel]');

  // 1. Open the example and Run: the proposal pauses the run before anything is written.
  await page.getByLabel('Open an example graph').selectOption({ label: '10 · AI wall roles (reviewed)' });
  await expect.poll(async () => (await state(page)).flow?.name).toBe('10 · AI wall roles (reviewed)');
  const graphId = (await state(page)).flow!.id;
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  const paused = await settled(page);
  expect(paused).toMatchObject({ ok: true, writes: 0, statuses: { walls: 'ok', table: 'ok', roles: 'review', apply: 'paused' }, written: null });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('Pset_WallCommon.IsExternal');
  const review = page.getByRole('region', { name: 'Review AI proposal', exact: true });
  await expect(review).toContainText('The run paused at roles. Nothing downstream of it runs until you approve this proposal.');
  await expect(review).toContainText('4 rows · 4 classified · 0 unknown · 0 failed · 0 not sent · 1 requests · model openai/gpt-4o-mini');
  await expect(review.locator('tbody tr')).toHaveCount(4);
  await expect(review.getByRole('status')).toHaveText(/Nothing downstream has run/);
  await panel.screenshot({ path: testInfo.outputPath('flow-ai-review-paused.png') });
  // The review card itself has no axe violations (scoped: the rest of the page has its own baseline).
  const axe = await new AxeBuilder({ page }).include('[data-flow-review]').analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

  // 2. The checkpoint is durable: after a reload and the same model, the same proposal awaits review.
  await page.reload();
  await openSample(page);
  await page.getByLabel('Flow graph', { exact: true }).selectOption({ label: '10 · AI wall roles (reviewed)' });
  await expect.poll(async () => (await state(page)).flow?.id).toBe(graphId);
  await panel.screenshot({ path: testInfo.outputPath('flow-ai-review-after-reload.png') });
  await expect(review).toContainText('4 rows · 4 classified');
  await expect(review.getByRole('button', { name: 'Approve and resume', exact: true })).toBeEnabled();

  // 3. Approve: the run resumes from the saved proposal, sends no new request and writes the labels.
  await review.getByRole('button', { name: 'Approve and resume', exact: true }).click();
  await expect(review.getByRole('status')).toHaveText(/Resumed from the approved proposal/, { timeout: 60_000 });
  const resumed = await settled(page);
  expect(resumed).toMatchObject({ ok: true, statuses: { walls: 'restored', table: 'restored', roles: 'restored', apply: 'ok' }, written: 4 });
  expect(sent).toHaveLength(1);
  await panel.screenshot({ path: testInfo.outputPath('flow-ai-review-resumed.png') });

  // 4. A new run is a new proposal; rejecting it ends the run with nothing downstream.
  await review.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(review.getByRole('button', { name: 'Reject', exact: true })).toBeVisible({ timeout: 60_000 });
  expect(sent).toHaveLength(2);
  await review.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(review.getByRole('status')).toHaveText('Rejected. Nothing downstream of the proposal ran.');
  await expect(review.getByRole('button', { name: 'Approve and resume', exact: true })).toHaveCount(0);
  await panel.screenshot({ path: testInfo.outputPath('flow-ai-review-rejected.png') });
});
