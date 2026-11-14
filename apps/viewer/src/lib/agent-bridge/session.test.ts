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
import { WALL_GID, model, parseHelloWall, seed } from '@/test/agent-tools-fixture';
import { connectAgentBridge, disconnectAgentBridge, setAgentBridgePermission } from './session';
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

it('the permission probe asks loopback-network, falls back to the older names for a denial only, and ignores prompt on a loopback page', async () => {
  const { queryLocalNetworkPermission } = await import('./session');
  const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const withPermissions = async (states: Record<string, PermissionState>, host: string) => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { permissions: {
      query: async ({ name }: { name: string }) => {
        if (!(name in states)) throw new TypeError(`unknown permission ${name}`);
        return { state: states[name] };
      },
    } } });
    try { return await queryLocalNetworkPermission(host); } finally { if (real) Object.defineProperty(globalThis, 'navigator', real); }
  };
  assert.equal(await withPermissions({ 'loopback-network': 'prompt' }, 'ifclite.com'), 'prompt');
  assert.equal(await withPermissions({ 'loopback-network': 'prompt' }, 'localhost'), 'unknown', 'a loopback page never needs the permission');
  assert.equal(await withPermissions({ 'loopback-network': 'denied' }, 'localhost'), 'denied');
  assert.equal(await withPermissions({ 'local-network-access': 'denied' }, 'ifclite.com'), 'denied', 'older Chrome: a denial still shows');
  assert.equal(await withPermissions({ 'local-network-access': 'prompt' }, 'ifclite.com'), 'unknown', 'older names never claim a pending prompt');
  assert.equal(await withPermissions({}, 'ifclite.com'), 'unknown');
});

/**
 * A hostile bridge (#9523 review): the tab's own grant is what stops an edit,
 * not the bridge's filtering. This "bridge" forwards edit calls whatever the
 * tab granted; the session must answer READ_ONLY and write nothing.
 */
it('the session refuses edits a bridge forwards while read-only, and again after a revoke', async () => {
  seed([model('hello', await parseHelloWall())]);
  connectAgentBridge({ port: 21517, code: 'ABCDE', bim: createBimContext({ backend: new LocalBackend(useViewerStore) }), WebSocket: LiveSocket as unknown as WebSocketConstructor });
  const socket = LiveSocket.last as LiveSocket;
  socket.readyState = 1;
  socket.onopen?.({});
  socket.onmessage?.({ data: JSON.stringify({ type: 'welcome', protocol: 1, sessionId: 's', permission: 'read-only', readOnlyCeiling: false, bridge: { name: 'b', version: '1' } }) });
  const undoDepth = () => useViewerStore.getState().undoStacks.get('hello')?.length ?? 0;
  const callEdit = async (id: string, value: string) => {
    socket.onmessage?.({ data: JSON.stringify({ type: 'call', sessionId: 's', id, name: 'entity_set_attribute', arguments: { global_id: WALL_GID, attribute: 'Name', value } }) });
    const deadline = Date.now() + 5000;
    for (;;) {
      const frame = socket.sent.map((text) => JSON.parse(text) as { type: string; id?: string; result?: { isError?: boolean; structuredContent?: { code?: string } } })
        .find((f) => f.type === 'result' && f.id === id);
      if (frame) return frame.result!;
      assert.ok(Date.now() < deadline, `no result for ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  const readOnly = await callEdit('e1', 'forwarded while read-only');
  assert.equal(readOnly.isError, true);
  assert.equal(readOnly.structuredContent?.code, 'READ_ONLY');
  assert.equal(undoDepth(), 0, 'nothing written');

  setAgentBridgePermission('read-write');
  const granted = await callEdit('e2', 'allowed');
  assert.equal(granted.isError, undefined, JSON.stringify(granted));
  assert.equal(undoDepth(), 1, 'the granted edit is one undo step');

  setAgentBridgePermission('read-only');
  const revoked = await callEdit('e3', 'forwarded after the revoke');
  assert.equal(revoked.isError, true);
  assert.equal(revoked.structuredContent?.code, 'READ_ONLY');
  assert.equal(undoDepth(), 1, 'nothing more written');
});
