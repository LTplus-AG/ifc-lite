/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ViewerBenchmarkPage } from '../benchmark/viewer-benchmark-page';

const fixture = join(process.cwd(), 'tests/models/ara3d/AC20-FZK-Haus.ifc');

// Recorded so the reviewer can watch the journey; the hosted-viewer privacy toast is acknowledged up front.
test.use({ video: 'retain-on-failure', viewport: { width: 1440, height: 1000 } });

type Counts = { applicable: number; passed: number; failed: number };
type StoreState = {
  models: Map<string, unknown>; loading: boolean; geometryStreamingActive: boolean;
  ifcDataStore: { entityCount: number } | null; selectedEntityId: number | null;
  idsValidationReport: { specificationResults: Array<{ specification: { id: string; name: string };
    applicableCount: number; passedCount: number; failedCount: number }> } | null;
  validationRuleSetEditing: boolean;
  documents: Array<{ id: string; name: string; blocks: Array<{ kind: string; source?: { kind: string; ruleId?: string } }> }>;
  activeDocumentId: string | null;
  openPanelInHome(panel: string): void;
};
const state = (page: Page) => page.evaluate(() => {
  const s = (globalThis as unknown as { __ifc_lite_viewer_store__: { getState(): StoreState } }).__ifc_lite_viewer_store__.getState();
  const report = s.idsValidationReport?.specificationResults.map(r => ({ id: r.specification.id, name: r.specification.name,
    applicable: r.applicableCount, passed: r.passedCount, failed: r.failedCount })) ?? null;
  return { report, selected: s.selectedEntityId, ruleEditing: s.validationRuleSetEditing, activeDocumentId: s.activeDocumentId,
    documents: s.documents.map(d => ({ id: d.id, name: d.name, tables: d.blocks.filter(b => b.kind === 'table').map(b => b.source?.ruleId ?? null) })) };
});

// Recorded provider answers; everything else is the real viewer on a real model file. The IDS draft comes from the
// IDS agent (IDS Studio P-07): scripted Anthropic Messages streams whose tool calls go through the real grounding gate.
const eq = (value: string | boolean) => ({ kind: 'equals', value });
const IDS_OPS = [
  { kind: 'spec.add', payload: { specId: '@walls', name: 'External walls are flagged', ifcVersions: ['IFC4'] } },
  { kind: 'facet.add', payload: { specId: '@walls', section: 'applicability', facetId: '@wa', facet: { type: 'entity', name: eq('IFCWALLSTANDARDCASE') } } },
  { kind: 'facet.add', payload: { specId: '@walls', section: 'requirements', facetId: '@wr', facet: { type: 'property', propertySet: eq('Pset_WallCommon'),
    baseName: eq('IsExternal'), dataType: eq('IFCBOOLEAN'), value: eq(true) } } },
  { kind: 'spec.add', payload: { specId: '@slabs', name: 'Slabs are at least 200 mm thick', ifcVersions: ['IFC4'] } },
  { kind: 'facet.add', payload: { specId: '@slabs', section: 'applicability', facetId: '@sa', facet: { type: 'entity', name: eq('IFCSLAB') } } },
  { kind: 'facet.add', payload: { specId: '@slabs', section: 'requirements', facetId: '@sr', facet: { type: 'property', propertySet: eq('Qto_SlabBaseQuantities'),
    baseName: eq('Width'), dataType: eq('IFCLENGTHMEASURE'), value: { kind: 'range', min: 200, minInclusive: true, unit: 'mm' } } } },
];
const sse = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
function agentStream(block: { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }): string {
  const usage = { input_tokens: 900, output_tokens: 1 };
  const start = block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: block.name, input: {} };
  const delta = block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) };
  return sse('message_start', { type: 'message_start', message: { id: 'msg_e2e', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [],
    stop_reason: null, stop_sequence: null, stop_details: null, usage } })
    + sse('content_block_start', { type: 'content_block_start', index: 0, content_block: start })
    + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta })
    + sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    + sse('message_delta', { type: 'message_delta', delta: { stop_reason: block.type === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null, stop_details: null },
      usage: { ...usage, output_tokens: 60 } })
    + sse('message_stop', { type: 'message_stop' });
}
const AGENT_TURNS = [
  agentStream({ type: 'tool_use', id: 'toolu_ids', name: 'ids_apply_ops', input: { ops: IDS_OPS, rationale: 'Walls and slabs',
    sources: [{ quote: 'external walls flagged, slabs at least 200 mm' }] } }),
  agentStream({ type: 'tool_use', id: 'toolu_unresolved', name: 'ids_mark_unresolved', input: { statement: 'Escape doors open outwards',
    category: 'geometry', reason: 'opening direction is geometry, not an IDS facet' } }),
  agentStream({ type: 'text', text: 'Two specifications; one statement is not expressible in IDS.' }),
];
const chips = (rules: unknown[]) => ({ groups: [{ combinator: 'AND', rules }], authoredAs: 'chips' });
const RULES_ANSWER = {
  version: 1, kind: 'rules.proposal', title: 'AC20 information rules',
  ruleSet: { version: 1, name: 'AC20 information rules', rules: [
    { id: 'door-fire-rating', name: 'Doors state a fire rating', severity: 'error',
      applicability: chips([{ kind: 'ifcType', values: ['IfcDoor'], op: 'in' }]),
      requirement: { kind: 'element', block: chips([{ kind: 'property', setName: 'Pset_DoorCommon', propertyName: 'FireRating', op: 'isSet', value: '' }]) } },
    { id: 'wall-names-unique', name: 'Wall names are unique', severity: 'warning',
      applicability: chips([{ kind: 'ifcType', values: ['IfcWallStandardCase'], op: 'in' }]),
      requirement: { kind: 'unique', subject: { kind: 'name' } } },
  ] },
  unsupported: [{ text: 'Party walls reach 53 dB airborne sound insulation', reason: 'acoustic performance needs a test certificate' }],
};
const outlineAnswer = (specification: string) => ({
  version: 1, kind: 'document.outline', title: 'AC20 wall findings',
  sections: [
    { heading: 'Summary', purpose: 'summary', blocks: [{ kind: 'validationSummary' }] },
    { heading: 'External walls', purpose: 'findings', blocks: [
      { kind: 'text', style: 'body', text: 'Walls the IDS expects to be flagged as external.' },
      { kind: 'validationTable', specification, rows: 'failed', columns: ['name', 'globalId', 'reason'] }] },
  ],
  unsupported: [{ text: 'Thermal bridges at slab edges', reason: 'needs a thermal simulation' }],
});

// #6915, IDS Studio P-07: agent-drafted IDS / rules / outline -> native audit and dry run on the loaded model -> save only after review -> native handoff.
test('assistant check drafts are dry-run natively and saved only after review', async ({ page }, testInfo) => {
  test.skip(!existsSync(fixture), 'AC20-FZK-Haus.ifc missing — run pnpm fixtures');
  await page.addInitScript(() => localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e'));
  const viewer = new ViewerBenchmarkPage(page);
  await viewer.setup();
  await viewer.loadFile(fixture);
  await expect.poll(async () => page.evaluate(() => {
    const s = (globalThis as unknown as { __ifc_lite_viewer_store__?: { getState(): StoreState } }).__ifc_lite_viewer_store__?.getState();
    return s?.models.size === 1 && !s.loading && !s.geometryStreamingActive && (s.ifcDataStore?.entityCount ?? 0) > 100;
  }), { timeout: 120_000 }).toBe(true);

  let outlineSpec = '';
  // `vite preview` has no chat proxy: answer the quota poll so it cannot hold the browser's connections open.
  await page.route('**/api/chat?usage=1', route => route.fulfill({ status: 404 }));
  await page.route('**/api/chat', async route => {
    const request = route.request().postDataJSON() as { messages: Array<{ content: string }> };
    const prompt = request.messages.at(-1)?.content ?? '';
    const answer = prompt.startsWith('Draft information rules') ? RULES_ANSWER : outlineAnswer(outlineSpec);
    await route.fulfill({ contentType: 'text/event-stream', body:
      `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(answer) } }] })}\n\ndata: [DONE]\n\n` });
  });
  const assistant = page.getByRole('region', { name: 'Assistant', exact: true });
  const ask = async (prompt: string) => {
    await assistant.getByLabel('Ask about these results').fill(prompt);
    await assistant.getByRole('button', { name: 'Send', exact: true }).click();
  };

  // IDS draft from the load report, by the IDS agent with the user's own key (scripted provider streams).
  let agentTurn = 0;
  await page.route('**/v1/messages', route => route.fulfill({ contentType: 'text/event-stream', body: AGENT_TURNS[agentTurn++] ?? AGENT_TURNS[2] }));
  const freeModel = await page.evaluate(() => {
    localStorage.setItem('ifc-lite:api-keys:v1', JSON.stringify({ anthropicKey: 'e2e-key-not-a-secret', anthropicWorkspaceId: '', openaiKey: '' }));
    const store = (globalThis as unknown as { __ifc_lite_viewer_store__: { getState(): StoreState & { setChatActiveModel(id: string): void } } }).__ifc_lite_viewer_store__;
    const previous = (store.getState() as unknown as { chatActiveModel: string }).chatActiveModel;
    store.getState().setChatActiveModel('claude-opus-5-5');
    store.getState().openPanelInHome('loadReport');
    return previous;
  });
  await page.getByRole('region', { name: 'Load report', exact: true }).getByRole('button', { name: 'Discuss with AI', exact: true }).click();
  await assistant.getByLabel('Ask about these results').fill('External walls flagged, slabs at least 200 mm; escape doors open outwards.');
  const ids = assistant.getByRole('region', { name: 'Draft IDS with tools', exact: true });
  await ids.getByRole('button', { name: 'Draft IDS from the message', exact: true }).click();
  await expect(ids).toContainText('Two specifications; one statement is not expressible in IDS.');
  await expect(ids).toContainText('Escape doors open outwards');
  await expect(ids).toContainText('2 of 2 changes kept');
  await ids.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('p07-ids-agent-proposal.png') });
  await ids.getByRole('button', { name: 'Use the kept changes', exact: true }).click();
  await expect(ids).toContainText('Native IDS audit: 0 errors');
  const saveIds = ids.getByRole('button', { name: 'Save to IDS library', exact: true });
  await expect(saveIds).toBeDisabled();
  await ids.getByRole('button', { name: 'Dry run on loaded models', exact: true }).click();
  const dry = ids.getByRole('region', { name: 'Dry-run results', exact: true });
  await expect(dry).toContainText('Dry run on 1 model');
  const dryCounts = (await dry.getByText(/\d+ applicable · \d+ passed · \d+ failed/).allTextContents()).map((text): Counts => {
    const [applicable, passed, failed] = text.match(/\d+/g)!.map(Number);
    return { applicable, passed, failed };
  });
  expect(dryCounts).toHaveLength(2);
  expect(dryCounts[0].applicable).toBeGreaterThan(0);
  expect(dryCounts[0].failed).toBeGreaterThan(0);
  expect((await state(page)).report, 'a dry run publishes no report').toBeNull();
  await dry.getByRole('button', { name: /^Show .* in the model$/ }).first().click();
  expect((await state(page)).selected, 'a failing sample selects in the model').not.toBeNull();
  await expect(saveIds).toBeEnabled();
  await ids.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('p07-ids-dry-run.png') });
  await saveIds.click();
  await expect(ids).toContainText('Saved to the Data validation IDS library');
  await ids.getByRole('button', { name: 'Open in Data validation', exact: true }).click();

  // The saved IDS runs in the native panel with the same counts the dry run showed.
  await page.getByRole('button', { name: 'Run Validation', exact: true }).click();
  await expect.poll(async () => (await state(page)).report?.length ?? 0, { timeout: 60_000 }).toBe(2);
  const native = (await state(page)).report!;
  expect(native.map(({ applicable, passed, failed }) => ({ applicable, passed, failed }))).toEqual(dryCounts);
  await page.screenshot({ path: testInfo.outputPath('p07-ids-native-run.png') });

  // The rest of the journey uses the hosted route again (the recorded `/api/chat` answers).
  await page.evaluate(model => {
    localStorage.removeItem('ifc-lite:api-keys:v1');
    (globalThis as unknown as { __ifc_lite_viewer_store__: { getState(): { setChatActiveModel(id: string): void } } }).__ifc_lite_viewer_store__.getState().setChatActiveModel(model);
  }, freeModel);

  // Information rules from the load report: per-element and set requirements IDS cannot express.
  await page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: { getState(): StoreState } })
    .__ifc_lite_viewer_store__.getState().openPanelInHome('loadReport'));
  await page.getByRole('region', { name: 'Load report', exact: true }).getByRole('button', { name: 'Discuss with AI', exact: true }).click();
  await ask('Draft information rules (uniqueness, counts, comparisons) for review: doors need a fire rating, wall names unique.');
  const rules = assistant.getByRole('region', { name: 'Review information rules', exact: true });
  await expect(rules).toContainText('property Pset_DoorCommon.FireRating isSet');
  await expect(rules).toContainText('Party walls reach 53 dB');
  await expect(rules.getByRole('button', { name: 'Save as rule set', exact: true })).toBeDisabled();
  await rules.getByRole('button', { name: 'Dry run on loaded models', exact: true }).click();
  await expect(rules.getByRole('region', { name: 'Dry-run results', exact: true })).toContainText(/\d+ applicable · \d+ passed · \d+ failed/);
  await rules.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('p07-rules-dry-run.png') });
  await rules.getByRole('button', { name: 'Save as rule set', exact: true }).click();
  await rules.getByRole('button', { name: 'Open in the rule editor', exact: true }).click();
  expect((await state(page)).ruleEditing).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('p07-rules-editor.png') });

  // Report outline from the native validation result, bound to the live report. Opening the saved rule set
  // made it the active definition, which (as any library switch does) cleared the shown report: run the IDS again.
  expect((await state(page)).report).toBeNull();
  await page.getByRole('tab', { name: 'IDS validation', exact: true }).click();
  await page.getByRole('button', { name: 'Run Validation', exact: true }).click();
  await expect.poll(async () => (await state(page)).report?.length ?? 0, { timeout: 60_000 }).toBe(2);
  expect((await state(page)).report).toEqual(native);
  outlineSpec = native[0].id;
  await page.getByRole('button', { name: 'Discuss with AI', exact: true }).click();
  await ask('Outline a validation report with live result tables');
  await expect(assistant).toContainText('2 sections · 1 requirement not checkable');
  const outline = assistant.getByRole('region', { name: 'Review report outline', exact: true });
  await expect(outline).toContainText(`live: ${native[0].failed} failed row`);
  await outline.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('p07-outline-review.png') });
  await outline.getByRole('button', { name: 'Save as new document', exact: true }).click();
  await expect(outline).toContainText('Saved to the Documents library');
  await outline.getByRole('button', { name: 'Open in Documents', exact: true }).click();
  const saved = await state(page);
  const doc = saved.documents.find(candidate => candidate.name === 'AC20 wall findings');
  expect(doc?.tables).toEqual([outlineSpec]);
  expect(saved.activeDocumentId).toBe(doc?.id);
  await expect(page.getByText('Outline drafted with AI assistance', { exact: false }).last()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath('p07-outline-document.png') });
});
