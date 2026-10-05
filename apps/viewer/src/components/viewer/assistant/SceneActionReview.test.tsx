/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { render, cleanup, click, type, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { cameraStub, sceneModels, W1, W2 } from '@/test/scene-actions-fixture';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { setActiveApplication, useSceneSession } from '@/lib/actions/scene-session';
import { AssistantPanel } from './AssistantPanel';

const initial = useViewerStore.getState();
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup(); cancelAssistant(); setActiveApplication(null); globalThis.fetch = originalFetch; useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

const button = (root: HTMLElement, name: string | RegExp) =>
  [...root.querySelectorAll('button')].find(b => typeof name === 'string' ? b.textContent === name : name.test(b.textContent ?? ''));

// #6907: proposal card → native review → explicit apply → restore, through the mounted Assistant.
test('a scene.actions answer is previewed inertly, applied on click and restored from the persistent bar', async () => {
  useViewerStore.setState({ ...sceneModels(), cameraCallbacks: cameraStub().callbacks });
  replaceEvidence(captureEvidence('loadReport'));
  const answer = JSON.stringify({ version: 1, kind: 'scene.actions', title: 'Failing walls', actions: [
    { type: 'isolate', targets: [{ globalId: W1 }, { globalId: '0Missing00000000000000' }] },
    { type: 'colour', groups: [{ label: 'Failing', colour: 'red', targets: [{ globalId: W1 }] }] },
    { type: 'section', units: 'm', plane: { origin: [0, 0, 0], normal: [0, 0, 1] } },
  ] });
  act(() => useAssistant.setState({ messages: [{ role: 'user', content: 'Show me the failing elements' }, { role: 'assistant', model: 'recorded', content: answer }] }));
  const ui = render(<AssistantPanel />);
  await waitFor(() => !!ui.querySelector('section[aria-label="Show in the model"]'), 'scene review card');
  assert.match(ui.textContent ?? '', /Scene action proposal/);
  assert.match(ui.textContent ?? '', /3 view actions/);
  const review = ui.querySelector('section[aria-label="Show in the model"]')!;
  assert.match(review.textContent ?? '', /Isolate · 1 element · 1 target not found or ambiguous/);
  assert.match(review.textContent ?? '', /Refused: the coordinates lie outside the loaded models/);
  assert.equal(useViewerStore.getState().isolatedEntities, null, 'reviewing changes nothing');

  click(button(review as HTMLElement, 'Apply 2 actions')!);
  assert.deepEqual([...useViewerStore.getState().isolatedEntities ?? []], [101]);
  await waitFor(() => !!button(ui, /Restore previous view/), 'restore bar');
  assert.match(review.textContent ?? '', /Applied to the view\./);
  assert.match(ui.textContent ?? '', /Applied to the view: Failing walls/);
  assert.equal(button(review as HTMLElement, 'Apply 2 actions')!.disabled, true, 'the applied proposal cannot be stacked on itself');

  // A later answer replaces the card; the restore point survives it.
  act(() => useAssistant.setState(s => ({ messages: [...s.messages, { role: 'user', content: 'Why?' }, { role: 'assistant', content: 'Because.' }] })));
  assert.equal(ui.querySelector('section[aria-label="Show in the model"]'), null);
  click(button(ui, /Restore previous view/)!);
  assert.equal(useViewerStore.getState().isolatedEntities, null);
  assert.equal(useSceneSession.getState().active, null);
  await waitFor(() => /Previous view restored\./.test(ui.textContent ?? ''), 'restore report');
});

test('composer attaches the selection only on request, refuses a screenshot for a text-only model and clears after sending', async () => {
  useViewerStore.setState({ ...sceneModels(), chatActiveModel: 'openai/gpt-free' });
  useViewerStore.getState().setSelectedEntityIds([102]);
  replaceEvidence(captureEvidence('loadReport'));
  let body = '';
  globalThis.fetch = async (_url, init) => {
    body = String(init?.body);
    return new Response('data: {"choices":[{"delta":{"content":"Ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  const ui = render(<AssistantPanel />);
  click(button(ui, 'Attach view')!);
  assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /cannot read images/);
  click(button(ui, 'Attach selection (1)')!);
  assert.match(ui.textContent ?? '', /Selection: 1 element/);
  type(ui.querySelector('textarea')!, 'What is selected?');
  click(button(ui, 'Send')!);
  await waitFor(() => useAssistant.getState().status === 'idle' && useAssistant.getState().messages.length === 2, 'send completes');
  assert.match(body, new RegExp(W2));
  assert.doesNotMatch(body, /data:image/);
  await waitFor(() => !/Selection: 1 element/.test(ui.textContent ?? ''), 'attachment cleared after the send');
  body = '';
  type(ui.querySelector('textarea')!, 'And now?');
  click(button(ui, 'Send')!);
  await waitFor(() => useAssistant.getState().messages.length === 4, 'second send completes');
  const sent = JSON.parse(body) as { messages: Array<{ content: unknown }> };
  assert.equal(sent.messages.at(-1)?.content, 'And now?', 'the next message carries no selection unless attached again');
});
