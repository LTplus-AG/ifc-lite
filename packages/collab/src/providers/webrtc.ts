/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebRTC provider (spec §8.1).
 *
 * `y-webrtc` lets two peers sync directly without going through a
 * central server — useful for offline-first / P2P use cases. This
 * module wraps it so consumers don't import `y-webrtc` directly and
 * the API matches our other providers.
 */

import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

export type WebRtcStatus = 'connecting' | 'connected' | 'disconnected';

export interface WebRtcProviderOptions {
  /** ICE / signaling URLs (default y-webrtc's public list). */
  signaling?: string[];
  /** Optional shared password — peers must agree. */
  password?: string;
  /** Awareness instance to share over the same transport. */
  awareness?: Awareness;
  /** Max simultaneous WebRTC connections. */
  maxConns?: number;
  /** Keep BroadcastChannel intra-browser sync (default true). */
  filterBcConns?: boolean;
  /** Connect on construction (default true). */
  connect?: boolean;
}

export interface WebRtcProvider {
  readonly roomId: string;
  readonly status: WebRtcStatus;
  onStatus(listener: (s: WebRtcStatus) => void): () => void;
  whenSynced: Promise<void>;
  connect(): void;
  disconnect(): void;
  destroy(): void;
}

/**
 * Build a WebRTC provider. `y-webrtc` is loaded lazily so consumers
 * who don't use this provider don't pay its bundle cost.
 */
export async function createWebRtcProvider(
  doc: Y.Doc,
  roomId: string,
  options: WebRtcProviderOptions = {},
): Promise<WebRtcProvider> {
  const mod = await import('y-webrtc' as string).catch(() => null);
  if (!mod) {
    throw new Error(
      '@ifc-lite/collab: y-webrtc is not installed. Run `pnpm add y-webrtc` and retry.',
    );
  }
  const { WebrtcProvider } = mod as { WebrtcProvider: new (...args: unknown[]) => unknown };

  // Honor `connect: false` end-to-end. Previously the option was only
  // reflected in the local status state, not passed to WebrtcProvider,
  // so the transport still auto-connected and violated the API contract.
  const autoConnect = options.connect !== false;
  const provider = new WebrtcProvider(roomId, doc, {
    signaling: options.signaling,
    password: options.password,
    awareness: options.awareness,
    maxConns: options.maxConns ?? 20,
    filterBcConns: options.filterBcConns ?? true,
    connect: autoConnect,
  } as never);

  // Track whether the consumer has manually disconnected so transient
  // y-webrtc events (e.g. a `peers` update with count=0) can't flip us
  // back to `connecting`. Manual disconnect stays disconnected until
  // `connect()` is called again.
  let manuallyDisconnected = !autoConnect;
  let status: WebRtcStatus = autoConnect ? 'connecting' : 'disconnected';
  const listeners = new Set<(s: WebRtcStatus) => void>();
  const setStatus = (s: WebRtcStatus) => {
    if (s === status) return;
    status = s;
    listeners.forEach((l) => l(s));
  };

  // y-webrtc emits 'peers' events when connections come up / go down.
  (provider as unknown as { on: (event: string, fn: (...args: unknown[]) => void) => void }).on(
    'peers',
    (info) => {
      if (manuallyDisconnected) return;
      const i = info as { webrtcPeers?: number[]; bcPeers?: number[] };
      const total = (i.webrtcPeers?.length ?? 0) + (i.bcPeers?.length ?? 0);
      setStatus(total > 0 ? 'connected' : 'connecting');
    },
  );
  (provider as unknown as { on: (event: string, fn: (...args: unknown[]) => void) => void }).on(
    'synced',
    () => {
      if (manuallyDisconnected) return;
      setStatus('connected');
    },
  );

  const whenSynced = new Promise<void>((resolve) => {
    (provider as unknown as { once: (event: string, fn: () => void) => void }).once(
      'synced',
      () => resolve(),
    );
  });

  return {
    roomId,
    get status() {
      return status;
    },
    onStatus(listener) {
      listeners.add(listener);
      listener(status);
      return () => listeners.delete(listener);
    },
    whenSynced,
    connect() {
      manuallyDisconnected = false;
      (provider as unknown as { connect: () => void }).connect();
      setStatus('connecting');
    },
    disconnect() {
      manuallyDisconnected = true;
      (provider as unknown as { disconnect: () => void }).disconnect();
      setStatus('disconnected');
    },
    destroy() {
      (provider as unknown as { destroy: () => void }).destroy();
    },
  };
}
