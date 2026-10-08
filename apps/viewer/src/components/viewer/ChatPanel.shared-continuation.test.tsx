/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { useRequestReceipts } from '@/lib/llm/request-receipts';
import { click, waitFor } from '@/test/render';
import { act } from 'react';
import { IfcTypeEnum } from '@ifc-lite/data';
import { code, reply, chatFrames, mountNative, send } from '@/test/script-chat-fixture';

test('#7093 Continue assembles a script split across two truncated turns before real native execution', async t => {
  let posts = 0;
  let release: () => void = () => { throw new Error('request not started'); };
  const parts = [reply.slice(0, 25), reply.slice(25, 50), reply.slice(50)];
  globalThis.fetch = async (_input, init) => {
    if (init?.method !== 'POST') return new Response('{}');
    const index = posts++;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      const deliver = () => { controller.enqueue(new TextEncoder().encode(chatFrames(parts[index], index < 2 ? 'length' : 'stop'))); controller.close(); };
      if (index === 0) release = deliver;
      else deliver();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const native = await mountNative(t); if (!native) return;
  send(native.ui);
  await waitFor(() => posts === 1 && useRequestReceipts.getState().inFlight.length === 1, 'first response exposes shared native request before bytes');
  await act(async () => release());
  for (let count = 1; count <= 2; count++) {
    await waitFor(() => useRequestReceipts.getState().receipts.length === count && !['sending', 'streaming'].includes(useViewerStore.getState().chatStatus), 'incomplete script settles');
    assert.equal(useViewerStore.getState().scriptLastResult, null);
    assert.equal(useViewerStore.getState().scriptEditorContent, '');
    assert.equal(useViewerStore.getState().chatToolReady, null);
    const button: HTMLButtonElement | undefined = [...native.ui.querySelectorAll('button')].find(candidate => candidate.textContent === 'Continue');
    assert.ok(button);
    click(button);
  }
  await waitFor(() => useViewerStore.getState().scriptLastResult !== null, 'assembled native query executes');
  assert.equal(useViewerStore.getState().scriptEditorContent, code);
  const expected = native.pair.head.ifcDataStore.entities.getByType(IfcTypeEnum.IfcWall).length;
  assert.ok(useViewerStore.getState().scriptLastResult?.logs.some(log => log.args[0] === '7093 native walls' && log.args[1] === expected));
  assert.deepEqual(useRequestReceipts.getState().receipts.map(receipt => receipt.outcome), ['truncated', 'truncated', 'completed']);
  assert.equal(posts, 3);
});
