/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import type { Renderer } from '@ifc-lite/renderer';
import { Scene } from '../../../../../../packages/renderer/src/scene';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { recomputeZoneAssignmentsNow } from '@/hooks/useZoneAssignmentSync';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { seedZoneExport } from '@/test/zone-export-fixture';
import { parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { captureSelectionGrounding, selectionGroundingIsCurrent } from '@/lib/actions/selection-grounding';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
import { ModelChangeProposal } from '@/components/viewer/assistant/ModelChangeProposal';
import { cleanup, render, click } from '@/test/render';
import { captureEvidence } from '../evidence';
import { useAssistant, replaceEvidence, cancelAssistant } from '../conversation';
import { sendAssistant } from '../request';
const state = useViewerStore.getState(), assistant = useAssistant.getState(), fetchBefore = globalThis.fetch;
afterEach(() => { cleanup(); cancelAssistant(); setGlobalRendererRef({ current: null }); globalThis.fetch = fetchBefore; useAssistant.setState(assistant, true); useViewerStore.setState(state, true); });
async function seed(t: TestContext) {
  if (!ensureWasm(t)) return null;
  const f = await seedZoneExport(), model = useViewerStore.getState().models.get('bonsai')!;
  useViewerStore.setState({ models: new Map([['bonsai', { ...model, idOffset: 0, maxExpressId: Math.max(...f.store.entityIndex.byId.keys()) }]]), editEnabled: true, collabRole: null, collabRoomId: null, storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), removedNewEntities: new Map(), removedMeshes: new Map(), dirtyModels: new Set(), mutationVersion: 0 });
  const scene = new Scene(); f.meshes.forEach(mesh => scene.addMeshData(mesh)); setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer });
  useViewerStore.getState().addEntityToSelection({ modelId: 'bonsai', expressId: f.wall.expressId }); useViewerStore.getState().setSelectedEntityIds([f.wall.expressId]); recomputeZoneAssignmentsNow(); return f;
}
function allText(value: unknown): string[] { return typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(allText) : value && typeof value === 'object' ? Object.values(value).flatMap(allText) : []; }
for (const route of ['rich', 'attached', 'zones'] as const) test(`#7322 actual ${route === 'attached' ? 'explicit Attach selection' : route === 'zones' ? 'rich Zones' : 'rich Selection'} provider request carries complete native evaluated emission choices`, async t => {
  const attached = route === 'attached';
  const f = await seed(t); if (!f) return;
  const grounding = captureSelectionGrounding(useViewerStore.getState()); assert.ok(grounding.elements[0].nativeZoneEmission, 'the actual provider producer must expose native zone emission evidence'); const choice = grounding.elements[0].nativeZoneEmission.choices.find(row => row.status === 'available'); assert.ok(choice?.expected);
  const source = captureEvidence(attached ? 'loadReport' : route === 'zones' ? 'zones' : 'selection');
  if (!attached && route === 'rich') { const row = JSON.parse(source.payload).evidence.rows[0]; assert.equal(row.rowProjectionTruncated, undefined); const transported = row.data.nativeZoneEmission.choices.find((item: { zoneSetId: string }) => item.zoneSetId === choice.zoneSetId); assert.deepEqual(JSON.parse(transported.expectedJsonParts.join('')), JSON.parse(JSON.stringify(choice.expected))); }
  if (route === 'zones') { const summary = JSON.parse(source.payload).evidence.summary; const model = summary.nativeZoneEmission.find((item: { modelId: string }) => item.modelId === 'bonsai'); const target = model.choices.find((item: { zoneSetId: string }) => item.zoneSetId === choice.zoneSetId); assert.deepEqual(JSON.parse(target.expectedJsonParts.join('')), JSON.parse(JSON.stringify(choice.expected))); }
  replaceEvidence(source); let wire: unknown;
  globalThis.fetch = async (_url, init) => { wire = JSON.parse(String(init?.body)); return new Response('data: {"choices":[{"delta":{"content":"Review the current native zone set"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); };
  assert.equal(await sendAssistant('Review explicitly named native zones', 'openai/gpt-free', '/api/chat', attached ? attachmentsForSend({ selection: grounding, screenshot: null }) : undefined), true);
  const text = allText(wire).join('\n'); assert.ok(text.includes('nativeZoneEmission')); assert.ok(text.includes('zones.emit')); assert.ok(text.includes(f.zoneSet.id)); assert.ok(text.includes(choice.expected.storey.GlobalId));
});
test('#7322 real streamed provider proposal reaches mounted whole-set review, explicit Apply, IFC membership and receipt Undo', async t => {
  const f = await seed(t); if (!f) return; await modelChangeLibrary.initialize();
  const grounding = captureSelectionGrounding(useViewerStore.getState()); assert.ok(grounding.elements[0].nativeZoneEmission, 'the actual provider producer must expose native zone emission evidence'); const choice = grounding.elements[0].nativeZoneEmission.choices.find(row => row.status === 'available'); assert.ok(choice?.expected);
  const proposal = { version: 1, kind: 'zones.emit', title: 'Review native Bonsai sections', modelId: 'bonsai', zoneSetId: choice.zoneSetId, storey: { GlobalId: choice.expected.storey.GlobalId, Name: choice.expected.storey.Name }, expected: choice.expected };
  replaceEvidence(captureEvidence('selection')); globalThis.fetch = async () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(proposal) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  assert.equal(await sendAssistant('Review this native evaluated zone set', 'openai/gpt-free', '/api/chat'), true);
  const ui = render(<ModelChangeProposal />), prepare = [...ui.querySelectorAll('button')].find(row => row.textContent === 'Prepare native zone emission'); assert.ok(prepare, ui.textContent ?? ''); click(prepare);
  const apply = [...ui.querySelectorAll('button')].find(row => row.textContent === 'Emit reviewed zones'); assert.ok(apply, ui.textContent ?? ''); assert.equal((f.store.entityIndex.byType.get('IFCSPATIALZONE') ?? []).length, 0); click(apply);
  const view = useViewerStore.getState().mutationViews.get('bonsai')!; assert.equal((await parseIfc(editedModelBytes(f.store, view))).entityIndex.byType.get('IFCSPATIALZONE')?.length, 1);
  assert.match(ui.textContent ?? '', /Other models are untouched/);
  const undo = [...ui.querySelectorAll('button')].find(row => row.textContent === 'Undo these changes'); assert.ok(undo); click(undo); assert.equal((await parseIfc(editedModelBytes(f.store, view))).entityIndex.byType.get('IFCSPATIALZONE')?.length ?? 0, 0);
});
test('#7322 actual stale attached evaluated zone-set snapshot refuses before HTTP after same-ID set change', async t => {
  const f = await seed(t); if (!f) return;
  const grounding = captureSelectionGrounding(useViewerStore.getState()), attachments = attachmentsForSend({ selection: grounding, screenshot: null }); assert.equal(selectionGroundingIsCurrent(grounding, useViewerStore.getState()), true);
  replaceEvidence(captureEvidence('loadReport')); useViewerStore.setState({ zoneSets: [{ ...f.zoneSet, name: 'Changed native set after explicit attachment' }] });
  assert.equal(selectionGroundingIsCurrent(grounding, useViewerStore.getState()), false);
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('stale attachment must not send'); };
  assert.equal(await sendAssistant('Use my previous attachment', 'openai/gpt-free', '/api/chat', attachments), false); assert.equal(calls, 0);
});
