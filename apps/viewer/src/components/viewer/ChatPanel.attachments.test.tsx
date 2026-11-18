/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { waitFor } from '@/test/render';
import { chatFrames, serveGated, mountProxy, send } from '@/test/script-chat-fixture';

// #9577 C-6: attachments belong to the turn that sent them, not the first reply chunk.
test('C-6 first streamed chunk preserves attachments added after Send', async () => {
  const { sent, release } = serveGated(chatFrames('Received.'));
  const ui = mountProxy();
  act(() => { useViewerStore.getState().addChatAttachment({ id: 'sent', name: 'sent.txt', type: 'text/plain', size: 1, textContent: 'old' }); });
  send(ui);
  await waitFor(() => sent.length === 1, 'request sent');
  assert.equal(sent[0].url.endsWith('/api/chat'), true, 'the attachment regression uses the cheap proxy route');
  act(() => { useViewerStore.getState().addChatAttachment({ id: 'next', name: 'next.txt', type: 'text/plain', size: 1, textContent: 'new' }); });
  await act(async () => release());
  await waitFor(() => useViewerStore.getState().chatStatus === 'idle', 'reply complete');
  assert.deepEqual(useViewerStore.getState().chatAttachments.map(a => a.id), ['next']);
});
