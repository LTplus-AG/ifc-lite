/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { RelationshipType } from '@ifc-lite/data';
import { effectiveMetadataRecord, type IfcDataStore } from '@ifc-lite/parser';
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
function sourceGraph(store: IfcDataStore) {
  // @raw-entity-enumeration-ok independent exported source parses have no overlay; compare their complete semantic records, not STEP header formatting.
  return [...store.entityIndex.byId.keys()].sort((a, b) => a - b).map(expressId => ({ expressId, ...effectiveMetadataRecord(store, expressId, null) }));
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
  assert.deepEqual(editedModelBytes(dataStore, view), before, 'native preview publishes no graph or history');
  const apply = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Apply 1 change');
  assert.ok(apply, ui.textContent ?? ''); assert.equal(apply.disabled, true);
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
  assert.deepEqual(sourceGraph(await parseIfc(restoredBytes)), sourceGraph(dataStore), 'one native Undo restores every original parsed record and removes the group subgraph');
});
