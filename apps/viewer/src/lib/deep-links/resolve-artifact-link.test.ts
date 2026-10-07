/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { captureEvidence } from '@/lib/assistant/evidence';
import { assistantLibrary, openConversation } from '@/lib/assistant/library';
import { useAssistant } from '@/lib/assistant/conversation';
import type { SavedConversation } from '@/lib/assistant/persistence';
import { parseDeepLink } from './artifact-link';
import { resolveDeepLink } from './resolve-artifact-link';

const initial = useViewerStore.getState();
const assistantInitial = useAssistant.getState();
afterEach(() => { useViewerStore.setState(initial, true); useAssistant.setState(assistantInitial, true); });
async function archive(id: string) {
  const evidence = captureEvidence('selection');
  const entry: SavedConversation = { version: 1, id, name: id, savedAt: new Date().toISOString(), model: 'recorded-test-model',
    evidence, messages: [{ role: 'user', content: `Recorded question for ${id}` }, { role: 'assistant', content: `Recorded answer for ${id}`, model: 'recorded-test-model' }] };
  assert.equal(await assistantLibrary.put(id, entry), true);
  return entry;
}
const link = (id: string) => ({ ok: true as const, panel: 'assistant' as const, artifact: { kind: 'conversation' as const, id } });

test('#6927 a native saved conversation link opens archived evidence read-only and can change archives', async () => {
  const first = await archive('deep-link-first');
  const second = await archive('deep-link-second');
  openConversation(first);
  const result = await resolveDeepLink(useViewerStore, link(second.id));
  assert.equal(result.status, 'opened');
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'assistant');
  assert.equal(useAssistant.getState().archived?.id, second.id);
  assert.equal(useAssistant.getState().snapshot, null, 'saved evidence never becomes current permission to act');
  assert.deepEqual(useAssistant.getState().messages, second.messages);
});

test('#6927 following a saved link preserves an unsaved conversation or active request', async () => {
  const target = await archive('deep-link-busy');
  const messages = [{ role: 'user' as const, content: 'Unsaved current question' }];
  useAssistant.setState({ archived: null, status: 'idle', messages });
  assert.equal((await resolveDeepLink(useViewerStore, link(target.id))).status, 'busy');
  assert.equal(useAssistant.getState().messages, messages);
  openConversation(target);
  useAssistant.setState({ status: 'streaming' });
  assert.equal((await resolveDeepLink(useViewerStore, link(target.id))).status, 'busy');
  assert.equal(useAssistant.getState().status, 'streaming');
});

test('#6927 missing saved artifacts open their owner without changing the conversation', async () => {
  const held = await archive('deep-link-held');
  openConversation(held);
  const result = await resolveDeepLink(useViewerStore, link('absent-saved-item'));
  assert.equal(result.status, 'missing');
  assert.equal(useAssistant.getState().archived?.id, held.id);
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'assistant');
});


test('#6927 conflicting panel parameters never open either destination', async () => {
  useViewerStore.getState().showWorkspacePanel('bcf', 'programmatic');
  for (const query of ['?panel=assistant&panel=clash', '?panel=clash&panel=assistant']) {
    const parsed = parseDeepLink(query);
    assert.ok(parsed);
    assert.deepEqual(await resolveDeepLink(useViewerStore, parsed), { status: 'refused', reason: 'conflicting-target' });
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'bcf');
  }
});
