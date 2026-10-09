/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { seedAuthoringSample, SAMPLE_MODEL, parseIfc } from '@/test/authoring-sample-fixture';
import { captureSelectionGrounding } from '@/lib/actions/selection-grounding';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
import { ModelChangeProposal } from '@/components/viewer/assistant/ModelChangeProposal';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { createCostBackend } from '@ifc-lite/sdk';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { render, click, cleanup } from '@/test/render';
import { captureEvidence } from '../evidence';
import { cancelAssistant, replaceEvidence, useAssistant } from '../conversation';
import { sendAssistant } from '../request';
const initial = useViewerStore.getState(), assistant = useAssistant.getState(), originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); cancelAssistant(); globalThis.fetch = originalFetch; useAssistant.setState(assistant, true); useViewerStore.setState(initial, true); });
async function selectedSource() {
  const fixture = await seedAuthoringSample();
  const state = useViewerStore.getState(), model = state.models.get(SAMPLE_MODEL)!;
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, maxExpressId: Math.max(...fixture.dataStore.entityIndex.byId.keys()) }]]) });
  useViewerStore.getState().addEntityToSelection({ modelId: SAMPLE_MODEL, expressId: 291 });
  useViewerStore.getState().setSelectedEntityIds([291]);
  return fixture;
}
function textContent(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textContent);
  if (value && typeof value === 'object') return Object.values(value).flatMap(textContent);
  return [];
}
for (const attached of [false, true]) test(`#7311 actual ${attached ? 'explicit attachment' : 'rich selection'} request retains complete native Cost snapshot including original declared units`, async () => {
  await selectedSource();
  const grounding = captureSelectionGrounding(useViewerStore.getState());
  assert.equal(grounding.elements.length, 1);
  assert.ok(grounding.elements[0].nativeCost, 'the actual native selection producer must expose Cost grounding');
  const expected = grounding.elements[0].nativeCost.expected;
  assert.ok(expected);
  const source = captureEvidence(attached ? 'loadReport' : 'selection');
  if (!attached) {
    const payload = JSON.parse(source.payload);
    assert.equal(payload.evidence.rows[0].rowProjectionTruncated, undefined, 'this native row must be complete in the bounded provider envelope');
    const cost = payload.evidence.rows[0].data.nativeCost;
    assert.equal(cost.status, 'available');
    assert.deepEqual(JSON.parse(cost.expectedJsonParts.join('')), JSON.parse(JSON.stringify(expected)), 'transport parts reconstruct the exact native snapshot');
  }
  replaceEvidence(source);
  let wire: unknown;
  globalThis.fetch = async (_url, init) => { wire = JSON.parse(String(init?.body)); return new Response('data: {"choices":[{"delta":{"content":"Review supplied costs"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); };
  assert.equal(await sendAssistant('Review explicitly supplied costs', 'openai/gpt-free', '/api/chat', attached ? attachmentsForSend({ selection: grounding, screenshot: null }) : undefined), true);
  const text = textContent(wire).join('\n');
  assert.ok(text.includes('nativeCost'));
  assert.ok(text.includes('SQUARE_METRE'), 'actual declared area unit reaches the provider');
  assert.ok(text.includes('cost.graph'), 'actual request advertises the separate reviewed graph contract');
  assert.ok(text.includes('3wdauVJT5Fx9drrREiDqA$'), 'actual selected native Root identity remains literal');
});
test('#7311 actual provider answer reaches mounted native selective approval, IFC save and receipt Undo', async () => {
  await modelChangeLibrary.initialize();
  const { dataStore, view } = await selectedSource();
  const grounding = captureSelectionGrounding(useViewerStore.getState());
  assert.ok(grounding.elements[0].nativeCost, 'the mounted proposal is grounded in the actual native producer');
  const expected = grounding.elements[0].nativeCost.expected;
  assert.ok(expected);
  const proposal = { version: 1, kind: 'cost.graph', title: 'Review two supplied schedules', modelId: SAMPLE_MODEL, expected,
    operations: [{ op: 'cost.schedule.create', params: { Name: 'Approved supplied schedule', PredefinedType: 'TENDER' } },
      { op: 'cost.schedule.create', params: { Name: 'Unapproved supplied schedule', PredefinedType: 'TENDER' } }] };
  replaceEvidence(captureEvidence('selection'));
  globalThis.fetch = async () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(proposal) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  assert.equal(await sendAssistant('Review these two supplied schedules', 'openai/gpt-free', '/api/chat'), true);
  const ui = render(<ModelChangeProposal />), boxes = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  assert.equal(boxes.length, 2, 'native graph proposal must reach actual review controls');
  act(() => boxes[1].click());
  const prepare = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Review selected cost operations');
  assert.ok(prepare, ui.textContent ?? ''); click(prepare);
  const apply = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Apply 1 change');
  assert.ok(apply, ui.textContent ?? ''); click(apply);
  assert.match(ui.textContent ?? '', /Applied 1 change/);
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  const graph = createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: saved })).data();
  assert.equal(graph.CostSchedules.some(row => row.Name === 'Approved supplied schedule'), true);
  assert.equal(graph.CostSchedules.some(row => row.Name === 'Unapproved supplied schedule'), false);
  const undo = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Undo these changes');
  assert.ok(undo); click(undo);
  assert.equal(createCostBackend(() => ({ modelId: SAMPLE_MODEL, store: dataStore, mutationView: view })).data().CostSchedules.length, 0);
});
