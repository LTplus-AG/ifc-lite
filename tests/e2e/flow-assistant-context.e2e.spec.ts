/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6919: preflight → Run → debug from the real run's diagnostics → rerun →
 * edit the tracked branch → rerun, on the committed `building-architecture.ifc`
 * sample through the real Flow panel. The graph is imported into the Flow
 * library as a coordinator would. Only the paid provider response is
 * recorded; validation, preflight, runs and tracking are the viewer's own. Runs in `viewer-e2e-ci` through the
 * project's `assistant-context` spec pattern.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { join } from 'node:path';
import { ViewerBenchmarkPage } from '../benchmark/viewer-benchmark-page';

// Room for the assistant's review cards beside the bottom Flow panel in the screenshots.
test.use({ viewport: { width: 1600, height: 1000 } });

const fixture = join(process.cwd(), 'apps/viewer/public/samples/building-architecture.ifc');

type Report = { nodeId: string; laneErrors: number; error?: string; tracking?: { created: number; updated: number; kept: number; removed: number } };
type Store = { getState(): {
  models: Map<string, unknown>; loading: boolean; geometryStreamingActive: boolean; ifcDataStore: { entityCount: number } | null;
  flowDoc: { name: string; nodes: Array<{ id: string; params?: Record<string, unknown> }> } | null; flowRunning: boolean;
  flowLastRun: { ok: boolean; reports: Report[]; log: Array<{ nodeId: string; level: string; message: string }> } | null; savedFlows: Array<{ doc: { name: string } }>;
  openPanelInHome(panel: string): void;
} };
const store = (page: Page) => page.evaluate(() => {
  const state = (globalThis as unknown as { __ifc_lite_viewer_store__: Store }).__ifc_lite_viewer_store__.getState();
  return { models: state.models.size, loading: state.loading, streaming: state.geometryStreamingActive,
    entities: state.ifcDataStore?.entityCount ?? 0, flowName: state.flowDoc?.name ?? null, running: state.flowRunning,
    lastRun: state.flowLastRun ? { ok: state.flowLastRun.ok, reports: state.flowLastRun.reports.map(r => ({ nodeId: r.nodeId, laneErrors: r.laneErrors, tracking: r.tracking,
      errors: state.flowLastRun!.log.filter(entry => entry.nodeId === r.nodeId && entry.level === 'error').map(entry => entry.message).slice(0, 2) })) } : null,
    saved: state.savedFlows.map(flow => flow.doc.name),
    xs: state.flowDoc?.nodes.find(node => node.id === 'xs')?.params?.items };
});

const columns = (xs: unknown[]) => ({ name: 'Columns along X', description: 'One column per X position on the first storey',
  nodes: [
    { id: 'storeys', type: 'model.byType', params: { type: 'IfcBuildingStorey' } }, { id: 'first', type: 'core.first' },
    { id: 'xs', type: 'core.list', params: { items: xs } }, { id: 'y', type: 'core.number', params: { value: 0 } },
    { id: 'pt', type: 'geometry.point' }, { id: 'column', type: 'element.column', params: { width: 0.3, depth: 0.3, height: 3 } },
    { id: 'add', type: 'model.addElement' },
  ],
  edges: [
    { from: ['storeys', 'entities'], to: ['first', 'items'] }, { from: ['xs', 'items'], to: ['pt', 'x'] },
    { from: ['y', 'value'], to: ['pt', 'y'] }, { from: ['first', 'item'], to: ['column', 'storey'] },
    { from: ['pt', 'point'], to: ['column', 'position'] }, { from: ['column', 'spec'], to: ['add', 'spec'] },
  ],
  outputs: [{ nodeId: 'add', port: 'entity', label: 'Columns' }] });
// Recorded answers keyed by the user's question; the assistant sees real evidence either way.
const ANSWERS: Array<[RegExp, unknown]> = [
  [/^Why did the last run fail/, { version: 1, kind: 'flow.patch', operations: [{ op: 'setParam', node: 'xs', param: 'items', value: [0, 4, 8] }],
    diagnosis: { nodes: ['pt'], explanation: 'The X positions are text; geometry.point needs numbers, so every lane failed and no column was added.' } }],
  [/^Drop the last column/, { version: 1, kind: 'flow.patch', operations: [{ op: 'setParam', node: 'xs', param: 'items', value: [0, 4] }] }],
];

test('#6919 Flow debugging with the assistant on a real sample', async ({ page }, testInfo) => {
  // The one-time privacy toast would cover the review cards in the screenshots.
  await page.addInitScript(() => localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e'));
  const viewer = new ViewerBenchmarkPage(page);
  await viewer.setup();
  await viewer.loadFile(fixture);
  await expect.poll(async () => { const s = await store(page); return s.models === 1 && !s.loading && !s.streaming && s.entities > 100; },
    { timeout: 120_000 }).toBe(true);
  const prompts: string[] = [];
  let lastSystem = '';
  await page.route('**/api/chat', async route => {
    const request = route.request().postDataJSON() as { messages: Array<{ content: string }>; system: string | Array<{ text: string }> };
    const prompt = request.messages.at(-1)?.content ?? '';
    prompts.push(prompt);
    lastSystem = typeof request.system === 'string' ? request.system : request.system.map(block => block.text).join('\n');
    const answer = ANSWERS.find(([pattern]) => pattern.test(prompt))?.[1] ?? 'No recorded answer.';
    await route.fulfill({ contentType: 'text/event-stream', body:
      `data: ${JSON.stringify({ choices: [{ delta: { content: typeof answer === 'string' ? answer : JSON.stringify(answer) } }] })}\n\ndata: [DONE]\n\n` });
  });
  await page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: Store }).__ifc_lite_viewer_store__.getState().openPanelInHome('flow'));
  const assistant = page.getByRole('region', { name: 'Assistant', exact: true });
  // The Flow header discusses the graph; the run bar discusses the last run (the `flowRun` source).
  const ask = async (question: string, source = 'Discuss with AI') => {
    await page.getByRole('button', { name: source, exact: true }).click();
    await assistant.getByLabel('Ask about these results').fill(question);
    await assistant.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(assistant.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  };
  const runInFlow = async () => {
    await page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: Store }).__ifc_lite_viewer_store__.getState().openPanelInHome('flow'));
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(async () => { const s = await store(page); return s.lastRun !== null && !s.running; }, { timeout: 60_000 }).toBe(true);
    return (await store(page)).lastRun!;
  };
  const shot = async (reveal: Locator, name: string) => {
    await reveal.scrollIntoViewIfNeeded();
    await assistant.screenshot({ path: testInfo.outputPath(name) });
  };

  // 1. A coordinator's graph in the Flow library: the Flow panel's own Run fails every lane on the text X positions.
  await page.evaluate(({ graph }) => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__: { getState(): { importFlow(doc: unknown): string | null } } }).__ifc_lite_viewer_store__.getState();
    if (!state.importFlow({ flowVersion: 2, id: 'columns-along-x', inputs: [], capabilities: ['model.create', 'model.read'], ...graph })) throw new Error('Flow library refused the graph');
  }, { graph: columns(['0', '4', '8']) });
  expect(await store(page)).toMatchObject({ saved: ['Columns along X'], flowName: 'Columns along X', lastRun: null });
  const failed = await runInFlow();
  expect(failed.reports.find(report => report.nodeId === 'pt')?.laneErrors).toBe(3);
  expect(failed.reports.find(report => report.nodeId === 'add')?.laneErrors).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('flow-run-lane-errors.png') });

  // 2. Debug from the captured run: the native error, not the model's, is cited; both acknowledgements gate apply.
  await ask('Why did the last run fail, and how can the graph be fixed?', 'Discuss run with AI');
  expect(lastSystem).toContain('"verdict":"lane-errors"');
  expect(lastSystem).toContain('must be a finite number');
  const patchReview = assistant.getByRole('region', { name: 'Review Flow changes', exact: true });
  await patchReview.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(patchReview).toContainText('Diagnosis of the last run');
  await expect(patchReview).toContainText('pt: ok · lane errors: 3');
  await expect(patchReview).toContainText('must be a finite number');
  await expect(patchReview).toContainText('add or its inputs change');
  const apply = patchReview.getByRole('button', { name: 'Apply graph changes', exact: true });
  await patchReview.getByRole('checkbox', { name: 'I reviewed the graph changes, tracking effects and additional capabilities.', exact: true }).check();
  await expect(apply).toBeDisabled();
  await shot(patchReview.getByText('Diagnosis of the last run'), 'flow-debug-review.png');
  await patchReview.getByRole('checkbox', { name: /I understand which tracked elements/ }).check();
  await apply.click();
  expect((await store(page)).xs).toEqual([0, 4, 8]);
  // Preflight reports what Run would hit (Edit mode is off), fixes it in place, and passes.
  await patchReview.getByRole('button', { name: 'Preflight', exact: true }).click();
  await expect(patchReview).toContainText('add edits the model: Turn on Edit mode before changing a model');
  await shot(patchReview.getByText(/add edits the model/), 'flow-preflight-edit-mode.png');
  await patchReview.getByRole('button', { name: 'Turn on Edit mode', exact: true }).click();
  await expect(patchReview.getByText(/Preflight passed for “Columns along X”/)).toBeVisible();
  const fixed = await runInFlow();
  expect(fixed.ok).toBe(true);
  expect(fixed.reports.filter(report => report.laneErrors > 0)).toEqual([]);
  expect(fixed.reports.find(report => report.nodeId === 'add')?.tracking).toEqual({ created: 3, updated: 0, kept: 0, removed: 0 });

  // 3. Edit the tracked branch: the review counts the three owned columns; the rerun keeps two and removes one.
  await ask('Drop the last column.');
  await patchReview.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(patchReview).toContainText('add or its inputs change: 3 owned elements under “Columns along X/add” are updated on the next Run.');
  await patchReview.getByRole('checkbox', { name: 'I reviewed the graph changes, tracking effects and additional capabilities.', exact: true }).check();
  await patchReview.getByRole('checkbox', { name: /I understand which tracked elements/ }).check();
  await shot(patchReview.getByText('Tracked elements affected'), 'flow-tracked-edit-review.png');
  await patchReview.getByRole('button', { name: 'Apply graph changes', exact: true }).click();
  const rerun = await runInFlow();
  expect(rerun.reports.find(report => report.nodeId === 'add')?.tracking).toEqual({ created: 0, updated: 0, kept: 2, removed: 1 });
  await page.screenshot({ path: testInfo.outputPath('flow-tracked-rerun.png') });
  expect(prompts).toHaveLength(2);
});
