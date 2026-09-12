/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Does the relay hold what I wrote?" (#4446)
 *
 * A local `doc.transact` resolves the moment the update is in the owner's
 * own Y.Doc; y-websocket then hands the bytes to the browser's socket, where
 * they sit in renderer-side send quota until the network stack drains them.
 * A tab closed in that window loses them — the relay never saw the seed,
 * and the next joiner reconstructs an empty room. No y-websocket event says
 * "the server has applied your update": the server forwards updates to the
 * OTHER peers and stays silent towards the origin.
 *
 * What the server does say, on every new connection, is its state vector —
 * step 1 of the y-protocols sync handshake. So a throw-away connection to
 * the room reads exactly "what the relay holds", a few dozen bytes, and
 * `stateVectorCovers` compares it with the owner's own state vector. The
 * probe sends nothing (no awareness, no updates), so peers never see it.
 */

import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';

/** y-websocket message tag for sync frames; y-protocols sync sub-tag for step 1. */
const MESSAGE_SYNC = 0;
const SYNC_STEP1 = 0;

export interface RelayStateVectorOptions {
  /** Bearer token attached as `?token=` (the same one the live provider uses). */
  token?: string;
  /** Custom WebSocket implementation (e.g. `ws` in Node). */
  WebSocketPolyfill?: unknown;
  /** Give up after this long (default 10 s). */
  timeoutMs?: number;
}

type WebSocketCtor = new (url: string) => {
  binaryType: string;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  close(): void;
};

/** The same URL y-websocket dials for `(serverUrl, roomId, token)`. */
export function roomSocketUrl(serverUrl: string, roomId: string, token?: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${base}/${encodeURIComponent(roomId)}${query}`;
}

/**
 * Read the relay's state vector for `roomId` from the sync handshake of a
 * fresh connection, then close it. Rejects when the socket errors, closes
 * before the handshake, or `timeoutMs` passes.
 */
export function fetchRoomStateVector(
  serverUrl: string,
  roomId: string,
  options: RelayStateVectorOptions = {},
): Promise<Map<number, number>> {
  const Ctor = (options.WebSocketPolyfill ?? (globalThis as { WebSocket?: unknown }).WebSocket) as
    | WebSocketCtor
    | undefined;
  if (!Ctor) return Promise.reject(new Error('@ifc-lite/collab: no WebSocket implementation available'));
  return new Promise((resolve, reject) => {
    const ws = new Ctor(roomSocketUrl(serverUrl, roomId, options.token));
    ws.binaryType = 'arraybuffer';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('@ifc-lite/collab: relay did not send its state vector in time'))),
      options.timeoutMs ?? 10_000,
    );
    ws.onerror = () => finish(() => reject(new Error('@ifc-lite/collab: relay probe socket failed')));
    ws.onclose = (ev) => finish(() => reject(new Error(`@ifc-lite/collab: relay probe closed before the handshake (${ev.code ?? '?'} ${ev.reason ?? ''})`)));
    ws.onmessage = (ev) => {
      const data = ev.data;
      const bytes =
        data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
      if (!bytes) return;
      const decoder = decoding.createDecoder(bytes);
      if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return; // awareness, keepalive, …
      if (decoding.readVarUint(decoder) !== SYNC_STEP1) return;
      const sv = decoding.readVarUint8Array(decoder);
      finish(() => resolve(Y.decodeStateVector(sv)));
    };
  });
}

/**
 * Whether `held` (a relay's state vector) contains every write in `target`
 * (an owner's `Y.encodeStateVector(doc)`): for each client the relay's clock
 * must have reached ours.
 */
export function stateVectorCovers(target: Uint8Array | Map<number, number>, held: Map<number, number>): boolean {
  const want = target instanceof Map ? target : Y.decodeStateVector(target);
  for (const [client, clock] of want) {
    if ((held.get(client) ?? 0) < clock) return false;
  }
  return true;
}
