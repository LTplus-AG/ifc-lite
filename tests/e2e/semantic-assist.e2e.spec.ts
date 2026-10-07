/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer AI P16 (#6920): real panels, the real pilot models and the real review cards.
 * Only the paid provider answer and the SPARQL endpoint are intercepted; every
 * card is checked against the loaded models, not against canned data.
 */
import { test, expect, type Page } from '@playwright/test';
import type { ViewerState } from '../../apps/viewer/src/store';
import { ViewerBenchmarkPage } from '../benchmark/viewer-benchmark-page';

const STORE = '__ifc_lite_viewer_store__';
const REVISION = 'https://example.org/ifc-lite/pilot/revision/1';
const SPEC = 'Scope of works\n\nDoors in escape routes shall have a fire rating of EI30.\n\nCleaning is done as appropriate.';
const QUOTE = 'fire rating of EI30';
const START = SPEC.indexOf(QUOTE);
const SECRET = 'e2e-secret-credential';
const ENDPOINT = 'https://graph.example.org/records';
const span = (over: object = {}) => ({ source: 'S1', start: START, end: START + QUOTE.length, quote: QUOTE, ...over });

const ANSWERS: Record<string, unknown> = {
  REQUIREMENTS: { version: 1, kind: 'semantic.requirements', title: 'Escape-route door requirements', requirements: [
    { id: 'R1', statement: 'Escape-route doors need EI30', appliesTo: { ifcClass: 'IfcDoor' }, property: 'FireRating', operator: 'equals', value: 'EI30', span: span() },
    { id: 'R2', statement: 'Paraphrased quote that must not verify', span: span({ quote: 'fire resistance of EI30' }) }],
  unsupported: [{ text: 'Cleaning is done as appropriate.', reason: 'No measurable criterion', span: span({ start: SPEC.indexOf('Cleaning'), end: SPEC.indexOf('Cleaning') + 8, quote: 'Cleaning' }) }] },
  MAPPING: { version: 1, kind: 'semantic.mapping', title: 'Door fire rating mapping', modelRevision: REVISION, mappings: [
    { ifc: { class: 'IfcDoor', pset: 'Pset_DoorCommon', property: 'FireRating' }, ontology: { property: 'fireRating' }, confidence: 0.9, rationale: 'The specification names the rating.', sources: [span()] },
    { ifc: { class: 'IfcDoor', pset: 'Pset_DoorCommon', property: 'Other' }, ontology: { property: 'made up term' }, confidence: 0.3, sources: [span()] }] },
  QUERY: { version: 1, kind: 'semantic.query', title: 'Installed doors', purpose: 'List installed doors with their identity.',
    expected: { form: 'select', columns: ['id', 'GlobalId', 'modelRevision'] },
    query: 'SELECT ?id ?GlobalId ?modelRevision WHERE { ?id ?p ?GlobalId } LIMIT 50' },
  PROJECTION: { version: 1, kind: 'semantic.projection', title: 'Project fire rating', projections: [
    { resource: 'https://example.org/ifc-lite/pilot/installation/1', field: 'fireRating', policy: 'overwrite' },
    { resource: 'https://example.org/missing', field: 'fireRating' }] },
};

async function openPanel(page: Page, id: string) {
  await page.getByRole('tab', { name: 'Analyze', exact: true }).click();
  await page.getByRole('button', { name: 'Browse panels', exact: true }).click();
  await page.getByRole('menu').locator(`[data-panel-id="${id}"]`).click();
}

test('linked-records assistant: spans, grants, revision pins and reviewed apply (#6920)', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const viewer = new ViewerBenchmarkPage(page); await viewer.setup();
  await page.waitForFunction(key => !!(globalThis as unknown as Record<string, unknown>)[key], STORE);
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) });

  await openPanel(page, 'semantic');
  const panel = page.getByRole('region', { name: 'Linked records', exact: true });
  await panel.getByRole('button', { name: 'Load pilot models and records', exact: true }).click();
  await page.waitForFunction(key => {
    const state = (globalThis as unknown as Record<string, { getState(): ViewerState }>)[key].getState();
    return state.models.size === 2 && !state.loading && !state.geometryStreamingActive && [...state.models.values()].every(model => model.ifcDataStore && model.geometryResult?.meshes.length === 3);
  }, STORE, { timeout: 180000 });
  await expect(panel.getByRole('button', { name: 'Select Installed door 1', exact: true })).toBeVisible();

  // The specification is attached explicitly; nothing is attached by opening the assistant.
  await panel.getByText('Assistant texts and saved reviews', { exact: true }).click();
  await panel.getByLabel('Text name').fill('Door specification');
  await panel.getByLabel('Specification text').fill(SPEC);
  await panel.getByRole('button', { name: 'Attach text', exact: true }).click();
  await expect(panel).toContainText('S1: Door specification');

  // A real grant: load records from a granted endpoint (intercepted at the network edge), with a credential.
  await panel.getByText('Portable workspace', { exact: true }).click();
  await panel.getByRole('button', { name: 'Save and download workspace', exact: true }).click();
  const workspace = await page.evaluate(() => JSON.parse(localStorage.getItem('ifc-lite.semantic.workspace.v1') ?? 'null') as { document: unknown } | null);
  expect(workspace?.document).toBeTruthy();
  const doors = await page.evaluate(key => {
    const state = (globalThis as unknown as Record<string, { getState(): ViewerState }>)[key].getState();
    const store = [...state.models.values()][0].ifcDataStore!;
    return (store.entityIndex.byType.get('IFCDOOR') ?? []).map(id => store.entities.getGlobalId(id));
  }, STORE);
  expect(doors).toHaveLength(3);
  const requests: Array<{ method: string; authorization: string | null }> = [];
  await page.route('https://graph.example.org/**', async route => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    requests.push({ method: request.method(), authorization: await request.headerValue('authorization') });
    if (request.method() === 'GET') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(workspace!.document) });
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/sparql-results+json' }, body: JSON.stringify({
      head: { vars: ['id', 'GlobalId', 'modelRevision'] }, results: { bindings: [
        ...doors.map((GlobalId, index) => ({ id: { type: 'uri', value: `https://example.org/ifc-lite/pilot/installation/${index + 1}` }, GlobalId: { type: 'literal', value: GlobalId }, modelRevision: { type: 'literal', value: REVISION } })),
        { id: { type: 'uri', value: 'https://example.org/none' }, GlobalId: { type: 'literal', value: '0000000000000000000999' }, modelRevision: { type: 'literal', value: REVISION } }] } }) });
  });
  // The grant lives only while the Linked records panel stays open, so float it beside the Assistant first.
  await page.getByRole('button', { name: 'Sidebar options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Float current panel', exact: true }).click();
  await expect(panel).toBeVisible();
  await panel.getByLabel('Data source').selectOption('json');
  await panel.getByLabel('Endpoint URL').fill(ENDPOINT);
  await panel.getByLabel('Allow requests to hostname').fill('graph.example.org');
  await panel.getByText('Authentication and relay', { exact: true }).click();
  await panel.getByLabel('Bearer credential (this panel session only)').fill(SECRET);
  await panel.getByRole('button', { name: 'Load records', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].authorization).toBe(`Bearer ${SECRET}`);
  // Let the load finish publishing, or the evidence captured next would already be out of date.
  await expect(panel.getByRole('button', { name: 'Load records', exact: true })).toBeEnabled();
  await shot('01-linked-records-attached-text');

  // Provider answers are the only intercepted model output; the card is chosen by the prompt.
  const outbound: string[] = [];
  await page.route('**/api/chat', async route => {
    const body = route.request().postDataJSON() as { system: string | Array<{ text: string }>; messages: Array<{ content: string }> };
    const system = typeof body.system === 'string' ? body.system : body.system.map(block => block.text).join('\n');
    outbound.push(system);
    const prompt = body.messages.at(-1)?.content ?? '';
    const key = Object.keys(ANSWERS).find(candidate => prompt.includes(candidate)) ?? 'REQUIREMENTS';
    await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(ANSWERS[key]) } }] })}\n\ndata: [DONE]\n\n` });
  });
  // #7000: recorded provider answers also run in builds without a configured default model.
  await page.evaluate(key => (globalThis as unknown as Record<string, { setState(next: object): void }>)[key].setState({ chatActiveModel: 'openai/gpt-free' }), STORE);
  await panel.getByRole('button', { name: 'Discuss with AI', exact: true }).click();
  const assistant = page.getByRole('region', { name: 'Assistant', exact: true });
  const ask = async (prompt: string) => {
    await assistant.getByLabel('Ask about these results').fill(prompt);
    await assistant.getByRole('button', { name: 'Send', exact: true }).click();
  };

  // Requirements: exact spans verified, a paraphrase flagged, the ambiguous statement retained.
  await ask('REQUIREMENTS: extract the requirements with their source passages');
  const requirements = assistant.getByRole('region', { name: 'Review extracted requirements', exact: true });
  await expect(requirements).toContainText('1 of 2 source quotes match the attached text exactly');
  await expect(requirements.getByText('Quote matches', { exact: true })).toHaveCount(2);
  await expect(requirements.getByText('Quote differs', { exact: true })).toHaveCount(1);
  await expect(requirements).toContainText('No measurable criterion');
  await requirements.scrollIntoViewIfNeeded();
  await shot('02-requirements-source-spans');
  await requirements.getByRole('button', { name: 'Save requirements with their verification', exact: true }).click();
  await expect(requirements).toContainText('Saved to your library.');

  // Mapping: the unknown term cannot be approved; the saved mapping carries its revision pin.
  await ask('MAPPING: map the door fire rating');
  const mapping = assistant.getByRole('region', { name: 'Review semantic mappings', exact: true });
  await expect(mapping).toContainText('3 elements in that model');
  const boxes = mapping.getByRole('checkbox');
  await expect(boxes.nth(1)).toBeDisabled();
  await boxes.nth(0).check();
  await mapping.scrollIntoViewIfNeeded();
  await shot('03-mapping-review');
  await mapping.getByRole('button', { name: 'Save 1 approved mapping', exact: true }).click();
  await expect(mapping).toContainText('Saved to your library.');

  // Query: the grant is shown without its credential; the run happens only on click and rows resolve per revision.
  await ask('QUERY: list the installed doors');
  const query = assistant.getByRole('region', { name: 'Review linked-records query', exact: true });
  const grant = query.getByRole('group', { name: 'Endpoint and grant' }).or(query.locator('dl[aria-label="Endpoint and grant"]'));
  await expect(grant).toContainText(ENDPOINT);
  await expect(grant).toContainText('Supplied (not shown, never sent to the assistant)');
  expect(await page.locator('body').innerText()).not.toContain(SECRET);
  expect(outbound.every(system => !system.includes(SECRET) && !system.includes('graph.example.org'))).toBe(true);
  expect(requests.length).toBe(1);
  await query.getByRole('button', { name: 'Run query', exact: true }).click();
  await expect(query).toContainText('Ran against https://graph.example.org/records');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual({ method: 'POST', authorization: `Bearer ${SECRET}` });
  await query.scrollIntoViewIfNeeded();
  await shot('04-query-run-resolved');

  // Changing the association makes the run historical, and the query card no longer resolves it against the current models.
  await page.evaluate(key => {
    const state = (globalThis as unknown as Record<string, { getState(): ViewerState }>)[key].getState();
    const models = new Map(state.models); models.delete([...models.keys()][1]);
    (globalThis as unknown as Record<string, { setState(next: object): void }>)[key].setState({ models });
  }, STORE);
  await expect(query).toContainText('Historical');
  await shot('05-query-historical');

  // The grant is withdrawn when the source changes.
  await panel.getByLabel('Endpoint URL').fill('https://other.example.org/records');
  await expect(query.getByRole('button', { name: 'Run query', exact: true })).toBeDisabled();
  await expect(query).toContainText('No endpoint is granted');
  await shot('06-query-grant-revoked');
});

test('linked-records assistant: projections apply through the native service as one undo step (#6920)', async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const viewer = new ViewerBenchmarkPage(page); await viewer.setup();
  await page.waitForFunction(key => !!(globalThis as unknown as Record<string, unknown>)[key], STORE);
  await openPanel(page, 'semantic');
  const panel = page.getByRole('region', { name: 'Linked records', exact: true });
  await panel.getByRole('button', { name: 'Load pilot models and records', exact: true }).click();
  await page.waitForFunction(key => {
    const state = (globalThis as unknown as Record<string, { getState(): ViewerState }>)[key].getState();
    return state.models.size === 2 && !state.loading && !state.geometryStreamingActive && [...state.models.values()].every(model => model.ifcDataStore && model.geometryResult?.meshes.length === 3);
  }, STORE, { timeout: 180000 });
  await expect(panel.getByRole('button', { name: 'Select Installed door 1', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Author', exact: true }).click();
  await page.getByRole('tabpanel', { name: 'Author', exact: true }).getByRole('button', { name: 'Model', exact: true }).click();
  await page.route('**/api/chat', async route => route.fulfill({ contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(ANSWERS.PROJECTION) } }] })}\n\ndata: [DONE]\n\n` }));
  await openPanel(page, 'semantic');
  // #7000: recorded provider answers also run in builds without a configured default model.
  await page.evaluate(key => (globalThis as unknown as Record<string, { setState(next: object): void }>)[key].setState({ chatActiveModel: 'openai/gpt-free' }), STORE);
  await panel.getByRole('button', { name: 'Discuss with AI', exact: true }).click();
  const assistant = page.getByRole('region', { name: 'Assistant', exact: true });
  await assistant.getByLabel('Ask about these results').fill('Which fields could be projected?');
  await assistant.getByRole('button', { name: 'Send', exact: true }).click();
  const review = assistant.getByRole('region', { name: 'Review record projections', exact: true });
  await expect(review).toContainText('not in the loaded records');
  const written = () => page.evaluate(key => {
    const state = (globalThis as unknown as Record<string, { getState(): ViewerState }>)[key].getState();
    return [...state.models.entries()].flatMap(([modelId, model]) => (model.ifcDataStore?.entityIndex.byType.get('IFCDOOR') ?? [])
      .map(id => state.getMutationView(modelId)?.getPropertyValue(id, 'Pset_DoorCommon', 'FireRating') ?? null)).filter(value => value === 'EI30').length;
  }, STORE);
  expect(await written()).toBe(0);
  await review.getByRole('checkbox').first().check();
  await review.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('07-projection-review.png') });
  await review.getByRole('button', { name: 'Apply 1 projection', exact: true }).click();
  await expect(review).toContainText('1 projection applied');
  await review.getByText('1 projection applied', { exact: false }).scrollIntoViewIfNeeded();
  expect(await written()).toBe(1);
  await page.screenshot({ path: info.outputPath('08-projection-applied.png') });
  await page.keyboard.press('Control+z');
  await expect.poll(written).toBe(0);
});
