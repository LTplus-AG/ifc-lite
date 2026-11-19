/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Websocket provider — wraps `y-websocket` with a typed status observable
 * and reconnect/backoff that we control.
 *
 * Spec §8.1.
 */

import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { markRejectionHandled } from '../internal/promise.js';

export type WebSocketStatus = 'connecting' | 'connected' | 'offline' | 'error';

export interface WebSocketProviderOptions {
  /** Custom WebSocket implementation (e.g. `ws` in Node tests). */
  WebSocketPolyfill?: unknown;
  /** Bearer token attached as `?token=` for the server to validate. */
  token?: string;
  /** Awareness instance to share over the same transport. */
  awareness?: Awareness;
  /** Disable connect on construction; call `connect()` explicitly. */
  connect?: boolean;
  /** Extra params appended to the connect URL. */
  params?: Record<string, string>;
  /**
   * Disable the BroadcastChannel intra-browser shortcut. When two tabs
   * open the same room in the same browser, y-websocket normally syncs
   * them via BroadcastChannel and never round-trips through the server.
   * Set true to force every edit through the websocket — useful for
   * demos / debugging server-side flows.
   */
  disableBc?: boolean;
}

export interface WebSocketProvider {
  readonly roomId: string;
  readonly status: WebSocketStatus;
  onStatus(listener: (status: WebSocketStatus) => void): () => void;
  /** Resolves on the first successful sync. */
  whenSynced: Promise<void>;
  connect(): void;
  disconnect(): void;
  destroy(): void;
}

/**
 * Create a websocket provider. Returns a thin wrapper so consumers don't
 * import `y-websocket` directly and can swap providers transparently.
 */
export async function createWebSocketProvider(
  doc: Y.Doc,
  roomId: string,
  serverUrl: string,
  options: WebSocketProviderOptions = {},
): Promise<WebSocketProvider> {
  const { WebsocketProvider } = await import('y-websocket');

  const params: Record<string, string> = { ...(options.params ?? {}) };
  if (options.token) params.token = options.token;

  const provider = new WebsocketProvider(serverUrl, roomId, doc, {
    WebSocketPolyfill: options.WebSocketPolyfill as never,
    awareness: options.awareness as never,
    connect: options.connect ?? true,
    disableBc: options.disableBc === true,
    params,
  });

  // `connect: false` leaves the transport idle until `connect()`, so the
  // honest starting status is 'offline', not 'connecting' (same contract the
  // webrtc provider honours).
  let status: WebSocketStatus = options.connect === false ? 'offline' : 'connecting';
  let destroyed = false;
  const listeners = new Set<(s: WebSocketStatus) => void>();
  const setStatus = (s: WebSocketStatus) => {
    if (status === s) return;
    status = s;
    listeners.forEach((l) => l(s));
  };

  provider.on('status', (event: { status: 'connected' | 'connecting' | 'disconnected' }) => {
    setStatus(
      event.status === 'connected'
        ? 'connected'
        : event.status === 'connecting'
          ? 'connecting'
          : 'offline',
    );
  });
  provider.on('connection-error', () => setStatus('error'));
  provider.on('connection-close', () => setStatus('offline'));

  // Settles exactly once: on the first sync, or — rejected — when the
  // provider is destroyed before it ever synced. Without the rejection a
  // caller awaiting sync on a provider torn down mid-join hung forever.
  let rejectUnsynced: ((err: Error) => void) | null = null;
  const whenSynced = new Promise<void>((resolve, reject) => {
    if (provider.synced) return resolve();
    rejectUnsynced = reject;
    provider.once('sync', () => {
      rejectUnsynced = null;
      resolve();
    });
  });
  markRejectionHandled(whenSynced);

  return {
    roomId,
    get status() { return status; },
    onStatus(listener) {
      listener(status);
      if (destroyed) return () => false;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    whenSynced,
    connect: () => {
      if (!destroyed) provider.connect();
    },
    disconnect: () => {
      if (!destroyed) provider.disconnect();
    },
    destroy: () => {
      if (destroyed) return;
      // y-websocket's destroy() drops its own observers, so no provider
      // event reaches `setStatus` after this. Announce the final 'offline'
      // once, then release the consumers' listeners.
      provider.destroy();
      setStatus('offline');
      destroyed = true;
      listeners.clear();
      rejectUnsynced?.(new Error(`@ifc-lite/collab: websocket provider for room "${roomId}" was destroyed before it synced`));
      rejectUnsynced = null;
    },
  };
}
