/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer AI P13 (#6914): assistant filter, list and chart proposals reviewed
 * against two federated committed samples (SketchUp `building-architecture.ifc`
 * plus `hello-wall.ifc`), loaded through Open and Add. Only the paid provider
 * response is recorded; every number on the review card comes from the
 * viewer's own engines. Oracles from the IFC file: wall NetSideArea
 * 6.346 + 8.928 + 21.154 + 6.863 = 43.291 m² over 4 of 8 wall/slab rows; slab
 * NetArea 79.363 m² over 3 slabs; one slab carries Pset_SlabCommon.FireRating.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ViewerState } from '../../apps/viewer/src/store';
import { ViewerBenchmarkPage } from '../benchmark/viewer-benchmark-page';
import { loadThroughViewer } from './federation-control-triplet.helpers';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
}

test.use({ video: 'on' });

const SAMPLES = 'apps/viewer/public/samples';
const walls = { combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] };
/** Recorded provider answers, keyed by a word of the user's prompt. */
const ANSWERS: Array<[RegExp, unknown]> = [
  [/list of walls/i, { version: 1, kind: 'list.proposal', title: 'Walls and slabs with area and fire rating', rationale: 'Area from the base quantities.',
    list: { name: 'Walls and slabs', entityTypes: ['IfcWall', 'IfcSlab'], columns: [
      { id: 'name', source: 'attribute', propertyName: 'Name' },
      { id: 'area', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetSideArea', label: 'Net side area' },
      // Not carried by any loaded element: the review must ask which field this means.
      { id: 'rating', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating', label: 'Fire rating' }] } }],
  [/chart/i, { version: 1, kind: 'chart.proposal', title: 'Slab area by class', scope: 'all', chart: { type: 'bar', dimension: 'IfcType',
    measure: { agg: 'sum' }, measureField: { kind: 'quantity', qsetName: 'Qto_SlabBaseQuantities', quantityName: 'NetArea' } } }],
  [/hello-wall/i, { version: 1, kind: 'filter.proposal', title: 'Walls in hello-wall.ifc', name: 'Walls in hello-wall',
    groups: [{ ...walls, rules: [...walls.rules, { kind: 'model', op: 'in', values: ['hello-wall.ifc'] }] }] }],
];

/** The review card stays inside the narrow assistant sidebar: no sideways overflow inside it, and no growth past it. */
async function fitsSidebar(review: Locator, sidebar: Locator): Promise<void> {
  const [card, panel] = await Promise.all([review.boundingBox(), sidebar.boundingBox()]);
  expect(card && panel && card.x + card.width <= panel.x + panel.width + 1, 'the card ends inside the sidebar').toBe(true);
  expect(await review.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), 'nothing overflows inside the card').toBe(true);
}

async function store<T>(page: Page, read: (state: ViewerState) => T): Promise<T> {
  return page.evaluate(`(${read.toString()})(globalThis.__ifc_lite_viewer_store__.getState())`) as Promise<T>;
}

test('assistant artifact proposals are reviewed by the native engines and saved into native libraries', async ({ page }, testInfo) => {
  const viewer = new ViewerBenchmarkPage(page);
  await viewer.setup();
  await loadThroughViewer(page, `${SAMPLES}/building-architecture.ifc`, 1, 120_000);
  await loadThroughViewer(page, `${SAMPLES}/hello-wall.ifc`, 2, 120_000);
  // Load-report evidence is pinned to the federation; wait until post-load bookkeeping stops replacing it.
  await expect.poll(() => page.evaluate(async () => {
    const before = globalThis.__ifc_lite_viewer_store__.getState().models;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return globalThis.__ifc_lite_viewer_store__.getState().models === before;
  }), { timeout: 60_000 }).toBe(true);

  const systems: string[] = [];
  await page.route('**/api/chat', async (route) => {
    const request = route.request().postDataJSON() as { system: string | Array<{ text: string }>; messages: Array<{ content: string }> };
    systems.push(typeof request.system === 'string' ? request.system : request.system.map((block) => block.text).join('\n'));
    const prompt = request.messages.at(-1)?.content ?? '';
    const answer = ANSWERS.find(([pattern]) => pattern.test(prompt))?.[1] ?? 'No proposal.';
    const content = typeof answer === 'string' ? answer : JSON.stringify(answer);
    await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n` });
  });
  // The first-visit privacy notice would cover the screenshots.
  await page.getByRole('button', { name: 'Dismiss notification', exact: true }).first().click();
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().openPanelInHome('loadReport'));
  await page.getByRole('region', { name: 'Load report', exact: true }).getByRole('button', { name: 'Discuss with AI', exact: true }).click();
  const assistant = page.getByRole('region', { name: 'Assistant', exact: true });

  // 1. List: the suggestion fills the prompt; the unknown property waits for a pick, made with the keyboard.
  await assistant.getByRole('button', { name: 'Build a list of walls with their area and fire rating', exact: true }).click();
  await expect(assistant.getByLabel('Ask about these results')).toHaveValue('Build a list of walls with their area and fire rating');
  await assistant.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(assistant).toContainText('List proposal');
  const review = assistant.getByRole('region', { name: 'Review against the loaded models', exact: true });
  const ambiguity = review.getByRole('group', { name: 'Pick the fields this means', exact: true });
  await expect(ambiguity).toContainText('Property Pset_WallCommon.FireRating');
  await expect(review.getByRole('button', { name: 'Save to Lists', exact: true }), 'nothing runs before every name resolves').toHaveCount(0);
  await ambiguity.scrollIntoViewIfNeeded();
  // The narrow sidebar never scrolls sideways, even for long dotted field names.
  await fitsSidebar(review, assistant);
  await assistant.screenshot({ path: testInfo.outputPath('p13-list-ambiguity.png') });
  const candidate = ambiguity.getByRole('radio', { name: /Pset_SlabCommon\.FireRating/ });
  await candidate.focus();
  await page.keyboard.press('Space');
  await expect(candidate).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(ambiguity.getByRole('button', { name: 'Use the selected fields', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(review).toContainText('8 elements matched');
  await expect(review).toContainText('Net side area: 43.291 m², summed over 4 of 8 rows.');
  await expect(review).toContainText('4 rows have no value and are not counted.');
  const population = review.getByRole('list', { name: 'Matched elements per model', exact: true });
  await expect(population.getByRole('listitem')).toHaveText([/building-architecture\.ifc\s*7 elements/, /hello-wall\.ifc\s*1 element/]);
  await fitsSidebar(review, assistant);
  await review.getByRole('button', { name: 'Save to Lists', exact: true }).scrollIntoViewIfNeeded();
  await assistant.screenshot({ path: testInfo.outputPath('p13-list-review.png') });
  await review.getByRole('button', { name: 'Save to Lists', exact: true }).click();
  await expect(review).toContainText('Saved as "Walls and slabs"');
  const saved = await store(page, (state) => state.listDefinitions.find((list) => list.name === 'Walls and slabs')?.columns.map((column) => `${column.psetName ?? ''}.${column.propertyName}`));
  expect(saved).toEqual(['.Name', 'Qto_WallBaseQuantities.NetSideArea', 'Pset_SlabCommon.FireRating']);
  await review.getByRole('button', { name: 'Open in the list editor', exact: true }).click();
  await expect(page.getByText('Edit List', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('p13-list-opened.png') });
  await page.getByRole('button', { name: 'Close Lists', exact: true }).click();

  // The schema digest went to the provider; the index itself did not.
  expect(systems[0]).toContain('Pset_SlabCommon.FireRating 1');
  expect(systems[0]).toContain('hello-wall.ifc (6 elements)');

  // 2. Chart: Charts aggregate total with its measured denominator, saved onto a dashboard.
  await assistant.getByLabel('Ask about these results').fill('Chart the slab area by IFC class');
  await assistant.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(assistant).toContainText('Chart proposal');
  await expect(review).toContainText('79.363 m², summed over 3 of 20 rows.');
  await expect(review.getByRole('table', { name: 'Chart categories', exact: true })).toContainText('IfcSlab');
  await review.getByRole('button', { name: 'Save to a dashboard', exact: true }).scrollIntoViewIfNeeded();
  await assistant.screenshot({ path: testInfo.outputPath('p13-chart-review.png') });
  await review.getByRole('button', { name: 'Save to a dashboard', exact: true }).click();
  await expect(review).toContainText('Saved "Slab area by class" on the dashboard');
  expect(await store(page, (state) => state.dashboards.flatMap((d) => d.charts.map((c) => c.title)))).toContain('Slab area by class');

  // 3. Filter scoped to one model: the name becomes the model's durable identity; it opens unsaved in the Filter tab.
  await assistant.getByLabel('Ask about these results').fill('Find the walls in hello-wall.ifc');
  await assistant.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(assistant).toContainText('Filter proposal');
  await expect(population.getByRole('listitem')).toHaveText([/building-architecture\.ifc\s*0 elements/, /hello-wall\.ifc\s*1 element/]);
  await review.getByRole('button', { name: 'Open in Filter without saving', exact: true }).scrollIntoViewIfNeeded();
  await assistant.screenshot({ path: testInfo.outputPath('p13-filter-review.png') });
  const before = await store(page, (state) => ({ selected: state.selectedEntityIds.size, hidden: state.hiddenEntities.size }));
  await review.getByRole('button', { name: 'Open in Filter without saving', exact: true }).click();
  await expect.poll(() => store(page, (state) => state.searchModalOpen && state.searchModalTab)).toBe('filter');
  const rule = await store(page, (state) => state.searchFilter.groups[0]?.rules.find((each) => each.kind === 'model'));
  const fingerprint = await store(page, (state) => [...state.models.values()].find((m) => m.name === 'hello-wall.ifc')?.sourceFingerprint);
  expect(rule).toEqual({ kind: 'model', op: 'in', values: [fingerprint] });
  expect(await store(page, (state) => ({ selected: state.selectedEntityIds.size, hidden: state.hiddenEntities.size })), 'opening never selects or hides').toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('p13-filter-opened.png') });
});
