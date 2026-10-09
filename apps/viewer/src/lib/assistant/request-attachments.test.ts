/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { clearApiKeys, updateApiKeys } from '@/services/api-keys';
import { captureSelectionGrounding, selectionGroundingText } from '@/lib/actions/selection-grounding';
import { sceneModels, W1 } from '@/test/scene-actions-fixture';
import { captureEvidence } from './evidence';
import { useAssistant, replaceEvidence, cancelAssistant } from './conversation';
import { sendAssistant } from './request';

const originalFetch = globalThis.fetch;
const initial = useViewerStore.getState();
afterEach(() => { cancelAssistant(); clearApiKeys(); globalThis.fetch = originalFetch; useViewerStore.setState(initial, true); });
const SHOT = 'data:image/jpeg;base64,AAAA';

function capture(): { calls: number; body: string } {
  const seen = { calls: 0, body: '' };
  globalThis.fetch = async (_url, init) => {
    seen.calls++;
    seen.body = String(init?.body);
    return new Response('data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  return seen;
}

// #6907: selection and screenshots reach a provider only when the user attached them to this send.
test('a send without attachments carries no image, even when the chat panel holds an auto-captured screenshot', async () => {
  useViewerStore.setState({ ...sceneModels(), chatViewportScreenshot: SHOT });
  store().setSelectedEntityIds([101]);
  replaceEvidence(captureEvidence('loadReport'));
  const seen = capture();
  assert.equal(await sendAssistant('Explain', 'openai/gpt-free', '/api/chat'), true);
  assert.equal(seen.calls, 1);
  assert.doesNotMatch(seen.body, /image_url|data:image/);
  assert.doesNotMatch(seen.body, new RegExp(W1), 'a live selection is not attached implicitly');
  assert.match(seen.body, /scene\.actions/, 'scene-action guidance is offered beside non-flow evidence');
});

test('an attached selection is sent as bounded GlobalId grounding and recorded in the turn', async () => {
  useViewerStore.setState(sceneModels());
  store().setSelectedEntityIds([101, 10_103]);
  const grounding = captureSelectionGrounding(store());
  assert.deepEqual(grounding.elements.map(({ nativeEdit, nativeType, nativeStairExpected, nativeSplitExpected, nativeHostedExpected, nativeTrimExtendExpected, nativeAuthoringAvailability, nativeAuthoringUnits, nativeAuthoringRefusals, ...identity }) => {
    assert.equal(nativeEdit.dimensionsStatus, 'unavailable', 'this identity-only fixture has no native geometry index');
    assert.deepEqual(nativeType, { status: 'unavailable', expected: null }, 'this identity-only fixture has no native type graph');
    assert.equal(nativeStairExpected, null, 'this identity-only fixture cannot prove native stair dimensions');
    assert.deepEqual([nativeSplitExpected, nativeHostedExpected, nativeTrimExtendExpected], [null, null, null], '#7282 identity-only fixtures cannot prove native operation snapshots');
    assert.deepEqual(nativeAuthoringAvailability, { split: 'unavailable-target', hosted: 'unavailable-target', stair: 'unavailable-target', trimExtend: 'unavailable-target' });
    assert.deepEqual(nativeAuthoringUnits, { split: 'm', hosted: 'm', stair: 'm', trimExtend: 'verbatim-native-fields' });
    assert.deepEqual(nativeAuthoringRefusals, { split: null, hosted: null });
    return identity;
  }), [
    { globalId: W1, modelId: 'a', type: 'IfcWall', name: 'Wall A' },
    { globalId: '0Shared000000000000001', modelId: 'b', type: 'IfcSlab', name: 'Slab copy' },
  ]);
  assert.equal(captureSelectionGrounding(store(), 1).truncated, true);
  replaceEvidence(captureEvidence('loadReport'));
  const seen = capture();
  await sendAssistant('Show these', 'openai/gpt-free', '/api/chat', { selection: selectionGroundingText(grounding) });
  assert.match(seen.body, new RegExp(W1));
  assert.match(useAssistant.getState().messages[0].content, /current viewer selection/);
});

test('a screenshot is refused for a model without image input and never fetched', async () => {
  useViewerStore.setState(sceneModels());
  replaceEvidence(captureEvidence('loadReport'));
  const seen = capture();
  assert.equal(await sendAssistant('What is this?', 'openai/gpt-free', '/api/chat', { screenshot: SHOT }), false);
  assert.equal(seen.calls, 0);
  assert.equal(useAssistant.getState().error, 'image-unsupported');
  assert.equal(useAssistant.getState().messages.length, 0);
});

test('an attached screenshot goes to an image-capable model once and is not persisted', async () => {
  useViewerStore.setState(sceneModels());
  updateApiKeys({ openaiKey: 'sk-test' });
  replaceEvidence(captureEvidence('loadReport'));
  const seen = capture();
  assert.equal(await sendAssistant('What is this?', 'gpt-6-luna', '/api/chat', { screenshot: SHOT }), true);
  assert.equal(seen.calls, 1);
  assert.match(seen.body, /data:image\/jpeg;base64,AAAA/);
  const stored = JSON.stringify(useAssistant.getState().messages);
  assert.doesNotMatch(stored, /base64/);
  assert.match(stored, /Attached: current viewport screenshot/);
});

function store() { return useViewerStore.getState(); }
