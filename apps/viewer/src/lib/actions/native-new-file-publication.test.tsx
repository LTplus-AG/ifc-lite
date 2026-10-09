/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { IfcParser, effectiveMetadataRecord } from '@ifc-lite/parser';
import { ModelChangeProposal } from '@/components/viewer/assistant/ModelChangeProposal';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, cancelAssistant } from '@/lib/assistant/conversation';
import { sendAssistant } from '@/lib/assistant/request';
import { clearApiKeys } from '@/services/api-keys';
import { useAssistant } from '@/lib/assistant/conversation';
import { useViewerStore } from '@/store';
import { cleanup, render, click, advance } from '@/test/render';
const initial = useAssistant.getState(), state = useViewerStore.getState();
afterEach(() => { cleanup(); useAssistant.setState(initial, true); useViewerStore.setState(state, true); });
const proposal = (Name = 'Supplied project') => ({ version: 1, kind: 'ifc.create', title: Name, filename: Name + '.ifc', project: { Name, Schema: 'IFC4', LengthUnit: 'METRE' }, storeys: [{ Name: 'Ground', Elevation: 0 }] });
function reply(Name?: string) { act(() => useAssistant.setState({ status: 'idle', messages: [{ role: 'assistant', content: JSON.stringify(proposal(Name)) }] })); }
function button(ui: HTMLElement, label: string) { const found = [...ui.querySelectorAll('button')].find(row => row.textContent === label); assert.ok(found, label); return found; }
async function prepared(ui: HTMLElement) { click(button(ui, 'Prepare new IFC file')); for (let i = 0; i < 50 && !ui.textContent?.includes('Download reviewed IFC'); i++) await advance(10); return button(ui, 'Download reviewed IFC'); }
test('#7326 mounted preparation offers actual native IFC bytes and leaves current session/history unchanged', async () => {
  reply(); const ui = render(<ModelChangeProposal />), before = useViewerStore.getState();
  const download = await prepared(ui); let blob: Blob | undefined, filename = '';
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, anchor = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = value => { assert.ok(value instanceof Blob); blob = value; return 'blob:new-ifc-native'; }; URL.revokeObjectURL = () => {}; HTMLAnchorElement.prototype.click = function () { filename = this.download; };
  try { click(download); } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; HTMLAnchorElement.prototype.click = anchor; }
  assert.ok(blob); const bytes = new TextEncoder().encode(await blob.text()), parsed = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  assert.equal(filename, 'Supplied project.ifc'); assert.equal(effectiveMetadataRecord(parsed, parsed.entityIndex.byType.get('IFCPROJECT')![0])?.attributes[2], 'Supplied project');
  assert.equal(parsed.entityIndex.byType.get('IFCBUILDINGSTOREY')?.length, 1); assert.equal(useViewerStore.getState().models, before.models); assert.equal(useViewerStore.getState().undoStacks, before.undoStacks);
});
test('#7326 same-origin changed assistant definition removes old prepared file and publication controls', async () => {
  reply(); const ui = render(<ModelChangeProposal />); await prepared(ui); reply('Replacement project'); await advance(0);
  assert.equal(ui.textContent?.includes('Supplied project.ifc'), false, 'old prepared bytes must not be presented for a new proposal');
  assert.equal([...ui.querySelectorAll('button')].some(row => row.textContent === 'Download reviewed IFC'), false);
});

test('#7326 explicit blank Models source reaches actual provider transport as capability, with zero invented existing facts', async () => {
  useViewerStore.setState({ models: new Map() }); replaceEvidence(captureEvidence('loadReport'));
  const original = globalThis.fetch; let body = '';
  globalThis.fetch = async (_url, init) => { body = String(init?.body); return new Response('data: {"choices":[{"delta":{"content":"Supply schema, units and elevations"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); };
  try { assert.equal(await sendAssistant('Create a native IFC scaffold using my supplied settings', 'openai/gpt-free', '/api/chat'), true); }
  finally { cancelAssistant(); clearApiKeys(); globalThis.fetch = original; }
  assert.ok(body.includes('ifc.create')); assert.ok(body.includes('native-new-ifc-scaffold')); assert.ok(body.includes('MILLIMETRE')); assert.ok(body.includes('existingModelFacts')); assert.ok(body.includes('primary')); assert.equal(useViewerStore.getState().models.size, 0);
});

test('#7326 actual asynchronous preparation cannot publish a superseded or unmounted review', async () => {
  reply(); const ui = render(<ModelChangeProposal />); let events = 0; const listener = () => { events++; }; window.addEventListener('ifc-lite:load-file', listener);
  try {
    click(button(ui, 'Prepare new IFC file')); reply('Replacement project'); await advance(20);
    assert.equal([...ui.querySelectorAll('button')].some(row => row.textContent === 'Download reviewed IFC'), false);
    await prepared(ui); assert.ok(ui.textContent?.includes('Replacement project.ifc')); assert.equal(ui.textContent?.includes('Supplied project.ifc'), false);
    click(button(ui, 'Prepare new IFC file')); cleanup(); await advance(20); assert.equal(events, 0); assert.equal(document.querySelector('[aria-label="Review new IFC file"]'), null);
  } finally { window.removeEventListener('ifc-lite:load-file', listener); }
});
