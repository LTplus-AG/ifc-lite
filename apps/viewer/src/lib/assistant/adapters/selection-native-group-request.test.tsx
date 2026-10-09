/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { RelationshipType } from '@ifc-lite/data';
import { addGroupToStore, readGroupEvidenceInStore } from '@ifc-lite/create';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { federationRegistry } from '@ifc-lite/renderer';
import { nativeGroupEvidence } from '@/lib/actions/group-lifecycle-evidence';
import { readOnlyModelEditTarget } from '@/lib/actions/model-authoring-read-target';
import { assertSameNativeIfcGraph } from '@/test/native-ifc-graph';
import { useViewerStore } from '@/store';
import { seedAuthoringSample, SAMPLE_MODEL, parseIfc, danglingReferences } from '@/test/authoring-sample-fixture';
import { captureSelectionGrounding } from '@/lib/actions/selection-grounding';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
import { ModelChangeProposal } from '@/components/viewer/assistant/ModelChangeProposal';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { render, click, cleanup } from '@/test/render';
import { captureEvidence } from '../evidence';
import { cancelAssistant, replaceEvidence, useAssistant } from '../conversation';
import { sendAssistant } from '../request';
const initial = useViewerStore.getState(), assistant = useAssistant.getState(), originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); cancelAssistant(); globalThis.fetch = originalFetch; useAssistant.setState(assistant, true); useViewerStore.setState(initial, true); });
async function selectedSource() {
  const fixture = await seedAuthoringSample();
  const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, maxExpressId: Math.max(...fixture.dataStore.entityIndex.byId.keys()) }]]) });
  useViewerStore.getState().addEntityToSelection({ modelId: SAMPLE_MODEL, expressId: 291 });
  useViewerStore.getState().setSelectedEntityIds([291]);
  return fixture;
}
function texts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(texts);
  return value && typeof value === 'object' ? Object.values(value).flatMap(texts) : [];
}
for (const attached of [false, true]) test(`#7329 actual ${attached ? 'explicit attachment' : 'rich selection'} request carries complete native Group identities and source ownership`, async () => {
  await selectedSource();
  const grounding = captureSelectionGrounding(useViewerStore.getState());
  const native = grounding.elements[0].nativeGroup;
  assert.equal(native?.status, 'available'); assert.ok(native?.snapshot);
  const source = captureEvidence(attached ? 'loadReport' : 'selection');
  replaceEvidence(source);
  if (!attached) {
    const payload = JSON.parse(source.payload);
    const group = payload.evidence.summary.nativeGroups[0];
    assert.equal(group.modelId, SAMPLE_MODEL); assert.equal(group.status, 'available');
    assert.deepEqual(JSON.parse(group.expectedJsonParts.join('')), JSON.parse(JSON.stringify(native.snapshot)));
  }
  let wire: unknown;
  globalThis.fetch = async (_url, init) => {
    wire = JSON.parse(String(init?.body));
    return new Response('data: {"choices":[{"delta":{"content":"Review group membership"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  assert.equal(await sendAssistant('Review this group membership', 'openai/gpt-free', '/api/chat', attached ? attachmentsForSend({ selection: grounding, screenshot: null }) : undefined), true);
  const text = texts(wire).join('\n');
  assert.ok(text.includes('group.lifecycle')); assert.ok(text.includes(native.snapshot.source.contentKey));
  assert.ok(text.includes('3wdauVJT5Fx9drrREiDqA$'));
  assert.ok(text.includes(attached ? 'nativeGroup' : 'nativeGroups'));
});

for (const attached of [false, true]) test(`#7329 ${attached ? 'attached' : 'rich'} request shares complete Group transport budget across two actual loaded sources`, async () => {
  const { dataStore, view } = await selectedSource(), peerId = 'group-budget-peer';
  const peerStore = await parseIfc(editedModelBytes(dataStore, view));
  const peerView = new MutablePropertyView(peerStore.properties || null, peerId);
  const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
  const make = (store: typeof dataStore, mutationView: typeof view, Name: string) => addGroupToStore(
    { store, mutationView, ownerHistoryId: null }, { Name, Description: '"'.repeat(1000), RelatedObjects: [] });
  const own = make(dataStore, view, 'First bounded source'), peer = make(peerStore, peerView, 'Second bounded source');
  federationRegistry.unregisterModel(SAMPLE_MODEL);
  const ownOffset = federationRegistry.registerModel(SAMPLE_MODEL, 100_000), peerOffset = federationRegistry.registerModel(peerId, 100_000);
  try {
    useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, idOffset: ownOffset }],
      [peerId, { ...model, id: peerId, idOffset: peerOffset, ifcDataStore: peerStore }]]),
      mutationViews: new Map([[SAMPLE_MODEL, view], [peerId, peerView]]) });
    useViewerStore.getState().clearSelection();
    for (const [modelId, group] of [[SAMPLE_MODEL, own], [peerId, peer]] as const) {
      useViewerStore.getState().addEntityToSelection({ modelId, expressId: group.expressId });
      assert.equal(nativeGroupEvidence(readOnlyModelEditTarget(useViewerStore.getState(), modelId), [group.expressId]).status, 'available');
    }
    useViewerStore.getState().setSelectedEntityIds([federationRegistry.toGlobalId(SAMPLE_MODEL, own.expressId), federationRegistry.toGlobalId(peerId, peer.expressId)]);
    const grounding = captureSelectionGrounding(useViewerStore.getState());
    assert.equal(grounding.unresolved, 0);
    const source = captureEvidence(attached ? 'loadReport' : 'selection'); replaceEvidence(source);
    let wire: unknown;
    globalThis.fetch = async (_url, init) => { wire = JSON.parse(String(init?.body));
      return new Response('data: {"choices":[{"delta":{"content":"Review captured source only"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); };
    assert.equal(await sendAssistant('Review captured groups', 'openai/gpt-free', '/api/chat',
      attached ? attachmentsForSend({ selection: grounding, screenshot: null }) : undefined), true);
    assert.deepEqual(grounding.elements.map(row => row.nativeGroup?.status), ['available', 'unavailable-transport-budget']);
    assert.equal(grounding.elements[0].nativeGroup?.snapshot?.groups[0].GlobalId, own.GlobalId);
    assert.equal(grounding.elements[1].nativeGroup?.snapshot, null);
    assert.ok(texts(wire).join('\n').includes('unavailable-transport-budget'));
  } finally { federationRegistry.unregisterModel(SAMPLE_MODEL); federationRegistry.unregisterModel(peerId); }
});

for (const attached of [false, true]) test(`#7329 ${attached ? 'attached' : 'rich'} request refuses oversized complete Group facts explicitly instead of exceeding the request budget`, async () => {
  const { dataStore, view } = await selectedSource();
  const context = { store: dataStore, mutationView: view, ownerHistoryId: null };
  const groups = Array.from({ length: 3 }, (_, index) => addGroupToStore(context,
    { Name: `Long description ${index}`, Description: '"'.repeat(7000), RelatedObjects: [] }));
  useViewerStore.getState().clearSelection();
  for (const group of groups) useViewerStore.getState().addEntityToSelection({ modelId: SAMPLE_MODEL, expressId: group.expressId });
  useViewerStore.getState().setSelectedEntityIds(groups.map(group => group.expressId));
  const native = readGroupEvidenceInStore(context, groups.map(group => group.expressId));
  assert.ok(JSON.stringify(JSON.stringify(native)).length > 90_000, 'actual escaped native facts exceed the unchanged request ceiling');
  const grounding = captureSelectionGrounding(useViewerStore.getState());
  const source = captureEvidence(attached ? 'loadReport' : 'selection');
  replaceEvidence(source);
  let wire: unknown;
  globalThis.fetch = async (_url, init) => {
    wire = JSON.parse(String(init?.body));
    return new Response('data: {"choices":[{"delta":{"content":"Reduce selected Group facts"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  assert.equal(await sendAssistant('Review selected groups', 'openai/gpt-free', '/api/chat',
    attached ? attachmentsForSend({ selection: grounding, screenshot: null }) : undefined), true, JSON.stringify({ error: useAssistant.getState().error, payload: source.payload.length, fields: grounding.elements.map(row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key, JSON.stringify(value)?.length]))) }));
  assert.equal(grounding.elements[0].nativeGroup?.status, 'unavailable-transport-budget');
  assert.equal(grounding.elements[0].nativeGroup?.snapshot, null);
  const text = texts(wire).join('\n');
  assert.ok(text.includes('unavailable-transport-budget'));
  assert.ok(text.includes('reduce the selected'));
});

test('#7329 actual provider answer reaches mounted selective Group review, native graph export and one receipt Undo', async () => {
  await modelChangeLibrary.initialize();
  const { dataStore, view } = await selectedSource(), before = editedModelBytes(dataStore, view);
  const expected = captureSelectionGrounding(useViewerStore.getState()).elements[0].nativeGroup?.snapshot;
  assert.ok(expected);
  const proposal = { version: 1, kind: 'group.lifecycle', title: 'Review two groups', modelId: SAMPLE_MODEL, expected,
    operations: [{ op: 'group.create', params: { Name: 'Approved group', RelatedObjects: expected.members } },
      { op: 'group.create', params: { Name: 'Unapproved group', RelatedObjects: [] } }] };
  replaceEvidence(captureEvidence('selection'));
  globalThis.fetch = async () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(proposal) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  assert.equal(await sendAssistant('Review these two groups', 'openai/gpt-free', '/api/chat'), true);
  const ui = render(<ModelChangeProposal />), boxes = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  assert.equal(boxes.length, 3, 'actual Group proposal must mount the operation and explicit review controls');
  act(() => boxes[1].click());
  const prepare = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Review selected group changes');
  assert.ok(prepare, ui.textContent ?? ''); click(prepare);
  await assertSameNativeIfcGraph(editedModelBytes(dataStore, view), before, 'native preview publishes no graph or history');
  const apply = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Apply 1 change');
  assert.ok(apply, ui.textContent ?? ''); assert.equal(apply.disabled, true);
  act(() => boxes[2].click()); assert.equal(apply.disabled, false);
  act(() => boxes[1].click());
  const expandedApply = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Apply 2 changes');
  assert.ok(expandedApply); assert.equal(expandedApply.disabled, true, 'a newly selected operation requires acknowledgment of its new complete preview');
  assert.equal(boxes[2].checked, false);
  act(() => boxes[1].click());
  assert.equal(apply.disabled, true, 'returning to the old selection still requires acknowledging the freshly prepared preview');
  assert.match(ui.textContent ?? '', /Native records: 2 created/);
  act(() => boxes[2].click()); assert.equal(apply.disabled, false); click(apply);
  assert.match(ui.textContent ?? '', /Applied 1 change/);
  const bytes = editedModelBytes(dataStore, view), saved = await parseIfc(bytes);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)), []);
  const groups = saved.entityIndex.byType.get('IFCGROUP') ?? [];
  assert.equal(groups.length, 1);
  assert.equal(saved.entities.getName(groups[0]), 'Approved group');
  assert.deepEqual(saved.relationships.getRelated(groups[0], RelationshipType.AssignsToGroup, 'forward'), [291]);
  assert.equal(saved.entities.getGlobalId(291), dataStore.entities.getGlobalId(291));
  const undo = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Undo these changes');
  assert.ok(undo); click(undo);
  const restoredBytes = editedModelBytes(dataStore, view);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(restoredBytes)), []);
  await assertSameNativeIfcGraph(restoredBytes, before, 'one native Undo restores every original parsed record and removes the group subgraph');
});
