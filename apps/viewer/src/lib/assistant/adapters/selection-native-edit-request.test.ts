/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { SAMPLE_MODEL, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { nativeEditTargets, nativeProfile } from '@/test/native-edit-evidence-fixture';
import { captureEvidence } from '../evidence';
import { cancelAssistant, replaceEvidence, useAssistant } from '../conversation';
import { sendAssistant } from '../request';
import { captureSelectionGrounding } from '@/lib/actions/selection-grounding';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
import { setElementDimensions } from '@/components/viewer/model-inspector/inspector-edits';

// Endpoint-only witness deliberately needs no newly added production exports;
// reverting the complete #7264 class must reach assertions, not a loader error.
const initial = useViewerStore.getState();
const initialAssistant = useAssistant.getState();
const originalFetch = globalThis.fetch;
afterEach(() => { cancelAssistant(); globalThis.fetch = originalFetch; useAssistant.setState(initialAssistant, true); useViewerStore.setState(initial, true); });
const s = useViewerStore.getState;
function intercept(receive: (body: string) => void) {
  globalThis.fetch = async (_url, init) => {
    receive(String(init?.body));
    return new Response('data: {"choices":[{"delta":{"content":"Review"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
}

test('#7264 provider request contains authoritative native dimensions and complete hollow Profile', async () => {
  await nativeEditTargets();
  replaceEvidence(captureEvidence('selection'));
  let request = '';
  intercept(body => { request = body; });
  assert.equal(await sendAssistant('Review editable selected geometry', 'openai/gpt-free', '/api/chat'), true);
  assert.match(request, /nativeEdit/);
  assert.match(request, /RectangleHollow/);
  assert.match(request, /InnerFilletRadius/);
  assert.match(request, /Native editable hollow beam/);
});

test('#7264 native Attach selection transports native editable geometry and authored identity', async () => {
  const { wall, beam } = await nativeEditTargets();
  s().setSelectedEntityIds([wall, beam]);
  const selection = captureSelectionGrounding(s());
  replaceEvidence(captureEvidence('loadReport'));
  let request = '';
  intercept(body => { request = body; });
  assert.equal(await sendAssistant('Review attached section', 'openai/gpt-free', '/api/chat', attachmentsForSend({ selection, screenshot: null })), true);
  assert.match(request, /nativeEdit/);
  assert.match(request, /RectangleHollow/);
  assert.equal(selection.elements[0].name, 'Native editable wall');
});

test('#7264 native attachment refuses a changed target even after unrelated evidence refresh', async () => {
  const { wall } = await nativeEditTargets();
  s().setSelectedEntityIds([wall]);
  const selection = captureSelectionGrounding(s());
  assert.equal(setElementDimensions(SAMPLE_MODEL, wall, { kind: 'wall', height: 5 }), true);
  replaceEvidence(captureEvidence('loadReport'));
  let requests = 0;
  intercept(() => { requests++; });
  assert.equal(await sendAssistant('Edit attached wall', 'openai/gpt-free', '/api/chat', attachmentsForSend({ selection, screenshot: null })), false);
  assert.equal(requests, 0);
});

test('#7264 unrelated native source selection and IFC attributes remain available', async () => {
  await seedAuthoringSample();
  s().setSelectedEntity({ modelId: SAMPLE_MODEL, expressId: 262 });
  const row = JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data;
  assert.equal(row.name, 'house - outer wall - house right front');
  assert.equal(row.type, 'IfcWall');
  assert.equal(nativeProfile.InnerFilletRadius, 0, 'the endpoint fixture retains its native optional-zero section');
});
