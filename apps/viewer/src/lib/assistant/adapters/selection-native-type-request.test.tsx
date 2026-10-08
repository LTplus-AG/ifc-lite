/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { SAMPLE_MODEL, seedAuthoringSample, GROUND_STOREY, parseIfc } from '@/test/authoring-sample-fixture';
import { createElementType, renameElement, setElementType } from '@/components/viewer/model-inspector/inspector-edits';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { captureSelectionGrounding } from '@/lib/actions/selection-grounding';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
import { captureEvidence } from '../evidence';
import { act } from 'react';
import { render, click, cleanup } from '@/test/render';
import { ModelChangeProposal } from '@/components/viewer/assistant/ModelChangeProposal';
import { readRelatedLists } from '@ifc-lite/create';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { cancelAssistant, replaceEvidence, useAssistant } from '../conversation';
import { sendAssistant } from '../request';

const initial = useViewerStore.getState(), assistant = useAssistant.getState(), originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); cancelAssistant(); globalThis.fetch = originalFetch; useAssistant.setState(assistant, true); useViewerStore.setState(initial, true); });

async function typedOccurrence() {
  const { dataStore, view } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const created = useViewerStore.getState().addWall(SAMPLE_MODEL, storey, { Start: [0, 0, 0], End: [4, 0, 0],
    Thickness: .2, Height: 3, Name: 'Native typed occurrence' });
  assert.ok('expressId' in created, 'error' in created ? created.error : '');
  const typeId = createElementType(SAMPLE_MODEL, 'wall', 'Initial native type', created.expressId);
  assert.ok(typeId !== null);
  assert.equal(renameElement(SAMPLE_MODEL, typeId, 'Renamed native type', 'Initial native type'), true);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const GlobalId = parsed.entities.getGlobalId(typeId);
  assert.ok(GlobalId);
  assert.equal(parsed.entities.getName(typeId), 'Renamed native type', 'actual independent export preserves native type and edited Name');
  useViewerStore.getState().addEntityToSelection({ modelId: SAMPLE_MODEL, expressId: created.expressId });
  useViewerStore.getState().setSelectedEntityIds([created.expressId]);
  return { GlobalId, Name: 'Renamed native type', dataStore, view, typeId, expressId: created.expressId };
}

for (const attached of [false, true]) {
  test(`#7267 ${attached ? 'explicit attachment' : 'rich selection'} request carries the current native overlay type identity`, async () => {
    const expected = await typedOccurrence();
    const grounding = attached ? captureSelectionGrounding(useViewerStore.getState()) : null;
    replaceEvidence(captureEvidence(attached ? 'loadReport' : 'selection'));
    let request = '';
    globalThis.fetch = async (_url, init) => {
      request = String(init?.body);
      return new Response('data: {"choices":[{"delta":{"content":"Review"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    };
    assert.equal(await sendAssistant('Review the current occurrence type', 'openai/gpt-free', '/api/chat',
      grounding ? attachmentsForSend({ selection: grounding, screenshot: null }) : undefined), true);
    assert.match(request, /nativeType/, 'provider receives the canonical current type expectation');
    assert.ok(request.includes(expected.GlobalId), 'the newly authored type GlobalId is present in provider input');
    assert.ok(request.includes(expected.Name), 'the edited native type Name is present in provider input');
  });
}


test('#7267 actual provider proposal reaches mounted selective review and preserves an unapproved typed peer', async () => {
  await modelChangeLibrary.initialize();
  const { dataStore, view, typeId, expressId } = await typedOccurrence();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const peer = useViewerStore.getState().addWall(SAMPLE_MODEL, storey, { Start: [0, 5, 0], End: [4, 5, 0],
    Thickness: .2, Height: 3, Name: 'Unapproved typed peer' });
  assert.ok('expressId' in peer, 'error' in peer ? peer.error : '');
  assert.equal(setElementType(SAMPLE_MODEL, peer.expressId, typeId), true);
  useViewerStore.getState().addEntityToSelection({ modelId: SAMPLE_MODEL, expressId: peer.expressId });
  useViewerStore.getState().setSelectedEntityIds([expressId, peer.expressId]);
  const grounding = captureSelectionGrounding(useViewerStore.getState());
  assert.equal(grounding.elements.length, 2);
  const proposal = JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Detach selected types', units: 'm',
    frame: 'storey-local', operations: grounding.elements.map(element => ({ op: 'type.detach',
      target: { globalId: element.globalId, modelId: element.modelId, ifcClass: element.type, name: element.name },
      expected: element.nativeType.expected })) });
  replaceEvidence(captureEvidence('selection'));
  globalThis.fetch = async () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: proposal }, finish_reason: 'stop' }] })
    + '\n\ndata: [DONE]\n\n');
  assert.equal(await sendAssistant('Detach both current types', 'openai/gpt-free', '/api/chat'), true);
  const ui = render(<ModelChangeProposal />);
  const boxes = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  assert.equal(boxes.length, 2);
  act(() => boxes[1].click());
  const apply = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Apply 1 operation');
  assert.ok(apply, ui.textContent ?? '');
  click(apply);
  assert.match(ui.textContent ?? '', /Applied 1 change/);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const relations = readRelatedLists(parsed, 'IfcRelDefinesByType', new MutablePropertyView(parsed.properties ?? null, 'parsed'));
  assert.equal(relations.some(relation => relation.relatedIds.includes(expressId)), false);
  assert.ok(relations.some(relation => relation.relatingId === typeId && relation.relatedIds.includes(peer.expressId)));
  assert.equal(parsed.entities.getName(typeId), 'Renamed native type');
});
