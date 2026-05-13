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

  let status: WebSocketStatus = 'connecting';
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

  const whenSynced = new Promise<void>((resolve) => {
    if (provider.synced) return resolve();
    provider.once('sync', () => resolve());
  });

  return {
    roomId,
    get status() { return status; },
    onStatus(listener) {
      listeners.add(listener);
      listener(status);
      return () => listeners.delete(listener);
    },
    whenSynced,
    connect: () => provider.connect(),
    disconnect: () => provider.disconnect(),
    destroy: () => provider.destroy(),
  };
}
