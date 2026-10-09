/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { captureEvidence } from '../assistant/evidence';
import { cancelAssistant, replaceEvidence } from '../assistant/conversation';
import { sendAssistant } from '../assistant/request';

const originalFetch = globalThis.fetch;
const initial = useViewerStore.getState();
afterEach(() => { cancelAssistant(); globalThis.fetch = originalFetch; useViewerStore.setState(initial, true); });

async function systemFor(source: 'loadReport' | 'clash'): Promise<string> {
  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  replaceEvidence(captureEvidence(source));
  let system = '';
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body)) as { system: string | Array<{ text: string }> };
    system = typeof payload.system === 'string' ? payload.system : payload.system.map(block => block.text).join('\n');
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
  };
  await sendAssistant('Draft checks', 'openai/gpt-free', '/api/chat');
  return system;
}

// #6915: the authoring contracts reach the provider in model and validation contexts only, within the prompt bound.
test('check authoring guidance is sent with model evidence, not with clash evidence', async () => {
  const withModels = await systemFor('loadReport');
  for (const kind of ['rules.proposal', 'document.outline']) assert.match(withModels, new RegExp(`"kind":"${kind.replace('.', '\\.')}"`));
  // IDS drafts go through the IDS agent, never a JSON contract (IDS-085).
  assert.doesNotMatch(withModels, /ids\.specifications/);
  assert.match(withModels, /Draft IDS with tools/);
  assert.match(withModels, /never drop them/);
  assert.ok(withModels.length < 90_000);
  assert.doesNotMatch(await systemFor('clash'), /rules\.proposal/);
});
