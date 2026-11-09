/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Teardown contracts of the websocket provider and the CollabSession façade:
 * idle status honesty, `whenSynced` settling when torn down before sync, and
 * a disposed session refusing writes and staying silent.
 *
 * The websocket is a fake (`WebSocketPolyfill`) that never opens, so nothing
 * here touches the network and no sync ever happens unless a test says so.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createWebSocketProvider } from '../src/providers/websocket.js';
import { CollabSessionDisposedError, createCollabSession } from '../src/session.js';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  binaryType = 'arraybuffer';
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

/** 'pending' when `promise` has not settled within a few macrotasks. */
async function settlement(promise: Promise<unknown>): Promise<'resolved' | 'rejected' | 'pending'> {
  const pending = new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20));
  return Promise.race([
    promise.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    pending,
  ]);
}

afterEach(() => {
  FakeWebSocket.instances = [];
});

describe('createWebSocketProvider lifecycle', () => {
  it("reports 'offline', not 'connecting', when constructed with connect: false", async () => {
    const provider = await createWebSocketProvider(new Y.Doc(), 'room', 'ws://relay.invalid', {
      WebSocketPolyfill: FakeWebSocket,
      connect: false,
      disableBc: true,
    });
    try {
      expect(provider.status).toBe('offline');
      expect(FakeWebSocket.instances.length).toBe(0);
    } finally {
      provider.destroy();
    }
  });

  it('rejects whenSynced when destroyed before the first sync', async () => {
    const provider = await createWebSocketProvider(new Y.Doc(), 'room', 'ws://relay.invalid', {
      WebSocketPolyfill: FakeWebSocket,
      disableBc: true,
    });
    provider.destroy();
    expect(await settlement(provider.whenSynced)).toBe('rejected');
    await expect(provider.whenSynced).rejects.toThrow(/destroyed before it synced/);
  });

  it('opens no socket on connect() after destroy, and stays offline', async () => {
    const provider = await createWebSocketProvider(new Y.Doc(), 'room', 'ws://relay.invalid', {
      WebSocketPolyfill: FakeWebSocket,
      connect: false,
      disableBc: true,
    });
    const seen: string[] = [];
    provider.onStatus((s) => seen.push(s));
    provider.destroy();
    provider.connect();
    expect(FakeWebSocket.instances.length).toBe(0);
    expect(provider.status).toBe('offline');
    expect([...seen]).toEqual(['offline']);
  });
});

describe('CollabSession dispose', () => {
  const wsSession = () =>
    createCollabSession({
      roomId: 'r',
      user: { id: 'u', name: 'U' },
      provider: 'websocket',
      serverUrl: 'ws://relay.invalid',
      WebSocketPolyfill: FakeWebSocket,
      disableBc: true,
    });

  it('rejects a pending whenSynced with CollabSessionDisposedError', async () => {
    const session = await wsSession();
    session.dispose();
    expect(await settlement(session.whenSynced)).toBe('rejected');
    await expect(session.whenSynced).rejects.toBeInstanceOf(CollabSessionDisposedError);
  });

  it('stops notifying status listeners once disposed', async () => {
    const session = await wsSession();
    const seen: string[] = [];
    session.onStatus((s) => seen.push(s));
    const before = [...seen];
    // Destroying the websocket inside dispose() flips it to 'offline'; a
    // listener still registered would hear that from a session the caller
    // already let go of.
    session.dispose();
    expect([...seen]).toEqual(before);
  });

  it('refuses transact and seed after dispose, and dispose is idempotent', async () => {
    const session = await createCollabSession({ roomId: 'r', user: { id: 'u', name: 'U' }, provider: 'memory' });
    session.dispose();
    session.dispose();
    expect(session.disposed).toBe(true);
    expect(() => session.transact(() => session.doc.getMap('entities').set('x', 1))).toThrow(
      CollabSessionDisposedError,
    );
    expect(session.doc.getMap('entities').has('x')).toBe(false);
    const file = {
      header: { id: 'h', ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 't', timestamp: '2026-01-01T00:00:00Z' },
      imports: [],
      schemas: {},
      data: [],
    };
    expect(() => session.seed(file)).toThrow(
      CollabSessionDisposedError,
    );
  });

  it('runs dispose listeners exactly once, and at once when already disposed', async () => {
    const session = await createCollabSession({ roomId: 'r', user: { id: 'u', name: 'U' }, provider: 'memory' });
    let calls = 0;
    session.onDispose(() => calls++);
    const unsubscribed = session.onDispose(() => {
      calls += 100;
    });
    unsubscribed();
    session.dispose();
    session.dispose();
    expect(calls).toBe(1);
    session.onDispose(() => calls++);
    expect(calls).toBe(2);
  });
});
