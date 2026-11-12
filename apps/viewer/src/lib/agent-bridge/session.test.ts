/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The session layer batches activity rows (#9523 review): a burst of calls is
 * a few UI-state updates, not one copy of the whole log per call.
 */

import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { connectAgentBridge, disconnectAgentBridge } from './session';
import { getAgentBridgeState, resetAgentBridgeStateForTests, subscribeAgentBridge } from './state';
import type { WebSocketConstructor } from './client';

class LiveSocket {
  static last: LiveSocket | null = null;
  readyState = 0;
  sent: string[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor() { LiveSocket.last = this; }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
}

afterEach(() => { disconnectAgentBridge(); resetAgentBridgeStateForTests(); });

it('twenty calls in a burst publish the activity log in a few batched updates', async () => {
  useViewerStore.setState({ models: new Map() });
  connectAgentBridge({ port: 21517, code: 'ABCDE', bim: createBimContext({ backend: new LocalBackend(useViewerStore) }), WebSocket: LiveSocket as unknown as WebSocketConstructor });
  const socket = LiveSocket.last as LiveSocket;
  socket.readyState = 1;
  socket.onopen?.({});
  socket.onmessage?.({ data: JSON.stringify({ type: 'welcome', protocol: 1, sessionId: 's', permission: 'read-only', readOnlyCeiling: false, bridge: { name: 'b', version: '1' } }) });
  let activityUpdates = 0;
  let last = getAgentBridgeState().activity;
  const stop = subscribeAgentBridge(() => {
    const now = getAgentBridgeState().activity;
    if (now !== last) activityUpdates++;
    last = now;
  });
  for (let i = 0; i < 20; i++) {
    socket.onmessage?.({ data: JSON.stringify({ type: 'call', sessionId: 's', id: `c${i}`, name: 'model_list', arguments: {} }) });
  }
  const deadline = Date.now() + 5000;
  while (getAgentBridgeState().activity.length < 20 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  stop();
  assert.equal(getAgentBridgeState().activity.length, 20, 'every call has a row');
  assert.ok(activityUpdates <= 4, `published in ${activityUpdates} updates`);
  assert.equal(socket.sent.filter((frame) => frame.includes('"result"')).length, 20, 'and every call was answered');
});
