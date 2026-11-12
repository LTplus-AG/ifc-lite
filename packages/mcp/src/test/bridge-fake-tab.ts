/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test double for the browser side of `--bridge` (#9523): a `ws` client that
 * speaks the tab half of `bridge/protocol.ts`. Used by the bridge tests only.
 */

import { randomBytes } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import WebSocket from 'ws';
import {
  BRIDGE_PROTOCOL_VERSION,
  parseServerMessage,
  type BridgeCallMessage,
  type BridgeCallResult,
  type BridgePermission,
  type BridgeServerMessage,
  type BridgeToolDescriptor,
  type BridgeWelcomeMessage,
} from '../bridge/bridge-protocol.js';

export const TEST_ORIGIN = 'https://ifclite.com';

export const READ_TOOL: BridgeToolDescriptor = {
  name: 'query_entities',
  description: 'List entities of a type in the open model.',
  inputSchema: { type: 'object', properties: { type: { type: 'string' } } },
  title: 'Query entities',
  readOnly: true,
};

export const MUTATING_TOOL: BridgeToolDescriptor = {
  name: 'set_property',
  description: 'Set a property value on an entity.',
  inputSchema: { type: 'object', properties: { id: { type: 'number' }, value: { type: 'string' } } },
  readOnly: false,
};

export interface FakeTabOptions {
  port: number;
  code: string;
  permission?: BridgePermission;
  tools?: BridgeToolDescriptor[];
  origin?: string;
  host?: string;
  protocol?: number;
}

/** Messages a socket received, with a way to wait for the next matching one. */
export class FakeTab {
  readonly received: BridgeServerMessage[] = [];
  closeCode: number | null = null;
  private waiters: Array<{ match: (m: BridgeServerMessage) => boolean; resolve: (m: BridgeServerMessage) => void }> = [];
  private closedWaiters: Array<(code: number) => void> = [];
  private consumed = new Set<BridgeServerMessage>();

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const parsed = parseServerMessage(data.toString());
      if (!parsed.ok) throw new Error(`fake tab got a malformed frame: ${parsed.error}`);
      this.received.push(parsed.value);
      for (const w of [...this.waiters]) {
        if (w.match(parsed.value)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(parsed.value);
        }
      }
    });
    ws.on('close', (code) => {
      this.closeCode = code;
      for (const w of this.closedWaiters.splice(0)) w(code);
    });
  }

  next<T extends BridgeServerMessage['type']>(type: T, timeoutMs = 2000): Promise<Extract<BridgeServerMessage, { type: T }>> {
    const seen = this.received.find((m) => m.type === type && !this.consumed.has(m));
    if (seen) {
      this.consumed.add(seen);
      return Promise.resolve(seen as Extract<BridgeServerMessage, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${type} frame within ${timeoutMs} ms`)), timeoutMs);
      this.waiters.push({
        match: (m) => m.type === type,
        resolve: (m) => {
          clearTimeout(timer);
          this.consumed.add(m);
          resolve(m as Extract<BridgeServerMessage, { type: T }>);
        },
      });
    });
  }

  closed(timeoutMs = 2000): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`socket not closed within ${timeoutMs} ms`)), timeoutMs);
      this.closedWaiters.push((code) => { clearTimeout(timer); resolve(code); });
    });
  }

  calls(): BridgeCallMessage[] {
    return this.received.filter((m): m is BridgeCallMessage => m.type === 'call');
  }

  sendRaw(frame: unknown): void {
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  reply(sessionId: string, id: string, result: BridgeCallResult): void {
    this.sendRaw({ type: 'result', sessionId, id, result });
  }

  close(): void {
    this.ws.close();
  }
}

/** Open a socket with the given headers. Resolves once open, or with the HTTP status that refused it. */
export function openSocket(opts: Pick<FakeTabOptions, 'port' | 'origin' | 'host'>): Promise<{ tab: FakeTab } | { status: number }> {
  const headers: Record<string, string> = {};
  if (opts.host !== undefined) headers.Host = opts.host;
  const ws = new WebSocket(`ws://127.0.0.1:${opts.port}/`, {
    headers,
    ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ tab: new FakeTab(ws) }));
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      ws.terminate();
    });
    ws.on('error', (err) => {
      // A refused upgrade also emits 'error' after 'unexpected-response'; the promise has settled by then.
      reject(err);
    });
  });
}

/** Open a socket and send `hello`. Does not wait for the reply. */
export async function connectTab(opts: FakeTabOptions): Promise<FakeTab> {
  const opened = await openSocket({ port: opts.port, origin: opts.origin ?? TEST_ORIGIN, host: opts.host });
  if (!('tab' in opened)) throw new Error(`upgrade refused with ${opened.status}`);
  opened.tab.sendRaw({
    type: 'hello',
    protocol: opts.protocol ?? BRIDGE_PROTOCOL_VERSION,
    pairingCode: opts.code,
    permission: opts.permission ?? 'read-only',
    tools: opts.tools ?? [READ_TOOL, MUTATING_TOOL],
    client: { name: 'fake-tab', version: '0' },
  });
  return opened.tab;
}

/** Connect and wait for `welcome`. */
export async function pairTab(opts: FakeTabOptions): Promise<{ tab: FakeTab; welcome: BridgeWelcomeMessage }> {
  const tab = await connectTab(opts);
  const welcome = await tab.next('welcome');
  return { tab, welcome };
}

export function textResult(text: string, extra: Partial<BridgeCallResult> = {}): BridgeCallResult {
  return { content: [{ type: 'text', text }], ...extra };
}

/**
 * A hand-rolled WebSocket client that IGNORES close frames: it completes the
 * upgrade, can send masked text frames at any time, and never answers a close.
 * `ws` clients always answer, so this is how a misbehaving peer is modelled.
 */
export interface RawPeer {
  /** Resolves with the HTTP status line once the upgrade is answered. */
  status: Promise<string>;
  /** Resolves when the server tears the TCP connection down. */
  ended: Promise<void>;
  sendText(text: string): void;
  destroy(): void;
}

export function rawPeer(port: number, origin = TEST_ORIGIN): RawPeer {
  const socket = netConnect(port, '127.0.0.1');
  let resolveStatus!: (line: string) => void;
  const status = new Promise<string>((r) => { resolveStatus = r; });
  const ended = new Promise<void>((r) => socket.once('close', () => r()));
  let head = '';
  socket.on('data', (chunk: Buffer) => {
    if (head.includes('\r\n')) return; // frames from the server are ignored, close frames included
    head += chunk.toString('latin1');
    if (head.includes('\r\n')) resolveStatus(head.slice(0, head.indexOf('\r\n')));
  });
  socket.on('error', () => { /* the server may reset us; `ended` reports it */ });
  socket.write([
    'GET / HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
    'Sec-WebSocket-Version: 13',
    `Origin: ${origin}`,
    '', '',
  ].join('\r\n'));
  return {
    status,
    ended,
    sendText(text) {
      const payload = Buffer.from(text, 'utf8');
      const mask = randomBytes(4);
      const len = payload.length;
      const header = len < 126
        ? Buffer.from([0x81, 0x80 | len])
        : Buffer.from([0x81, 0x80 | 126, len >> 8, len & 0xff]);
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
      if (!socket.destroyed) socket.write(Buffer.concat([header, mask, masked]));
    },
    destroy() { socket.destroy(); },
  };
}
