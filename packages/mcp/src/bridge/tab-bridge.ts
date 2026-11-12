/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The loopback WebSocket end of `--bridge` (#9523): accepts one paired
 * browser tab and forwards tool calls to it.
 *
 * Rules this class owns:
 *   - Listen on 127.0.0.1 only. The upgrade is refused (HTTP 403) unless the
 *     Host header is loopback on our port and the Origin is allowlisted.
 *   - The first frame must be a `hello` with the live one-time pairing code,
 *     within the handshake timeout. See `pairing.ts`.
 *   - One tab at a time. A new successful pairing REPLACES the paired tab:
 *     the old socket gets a `REPLACED` error and is closed, and its pending
 *     calls fail at once with reason `replaced`.
 *   - Mutating tools are not forwarded while the effective permission is
 *     read-only (the tab's grant, capped by `--read-only`).
 *   - A pending call ends by reply, timeout, cancellation or socket close; it
 *     never waits on a tab that has gone. See `session.ts` for reply matching.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import {
  BRIDGE_LIMITS,
  BRIDGE_PROTOCOL_VERSION,
  BridgeCloseCode,
  BridgeErrorCode,
  buildPairingUrl,
  parseTabMessage,
  type BridgeCallResult,
  type BridgePermission,
  type BridgeToolDescriptor,
} from './protocol.js';
import { hostAllowed, normalizeOrigin, originAllowed } from './guards.js';
import { DEFAULT_MAX_PAIRING_ATTEMPTS, PairingCodes } from './pairing.js';
import { BridgeCallError, BridgeSession, failSocket, looseId, rawToString } from './session.js';

export { BridgeCallError, type BridgeCallFailure } from './session.js';

export interface TabBridgeOptions {
  /** Port to bind on 127.0.0.1; 0 picks a free one. */
  port: number;
  /** Browser origins allowed to connect (exact scheme://host[:port]). */
  allowedOrigins: readonly string[];
  /** `--read-only`: mutating tools stay off whatever the tab grants. */
  readOnlyCeiling: boolean;
  /** Base of the pairing link. */
  viewerUrl: string;
  bridgeInfo: { name: string; version: string };
  callTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxMessageBytes?: number;
  maxPairingAttempts?: number;
  /** Unpaired sockets allowed at once; more are refused with 429. */
  maxPendingHandshakes?: number;
  /** One line of operator-facing log (stderr in the CLI). */
  log?: (line: string) => void;
}

export interface TabSnapshot {
  sessionId: string;
  /** Effective permission: the tab's grant capped by the ceiling. */
  permission: BridgePermission;
  tools: readonly BridgeToolDescriptor[];
  client?: { name: string; version?: string };
  connectedAt: Date;
}

export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export class TabBridge {
  private readonly log: (line: string) => void;
  private readonly callTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly maxPendingHandshakes: number;
  private readonly origins = new Set<string>();
  private readonly pairing: PairingCodes;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private boundPort = 0;
  private active: BridgeSession | null = null;
  private handshaking = new Set<WebSocket>();
  private listeners = new Set<() => void>();
  private closing = false;

  constructor(private readonly opts: TabBridgeOptions) {
    this.log = opts.log ?? (() => {});
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.maxPendingHandshakes = opts.maxPendingHandshakes ?? 4;
    for (const o of opts.allowedOrigins) {
      const normal = normalizeOrigin(o);
      if (normal === null) throw new Error(`not an http(s) origin: ${o}`);
      this.origins.add(normal);
    }
    this.pairing = new PairingCodes(opts.maxPairingAttempts ?? DEFAULT_MAX_PAIRING_ATTEMPTS, (code) => {
      this.log(`too many wrong pairing codes; that code is retired. New pairing link: ${this.pairingUrl(code)}`);
    });
  }

  get port(): number {
    return this.boundPort;
  }

  get readOnlyCeiling(): boolean {
    return this.opts.readOnlyCeiling;
  }

  get allowedOrigins(): readonly string[] {
    return [...this.origins];
  }

  async listen(): Promise<number> {
    const http = createServer((_req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('ifc-lite MCP bridge: WebSocket only\n');
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: this.opts.maxMessageBytes ?? BRIDGE_LIMITS.maxMessageBytes });
    http.on('upgrade', (req, socket, head) => this.onUpgrade(wss, req, socket, head));
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      // 127.0.0.1 only, never a public interface.
      http.listen(this.opts.port, '127.0.0.1', () => {
        http.off('error', reject);
        resolve();
      });
    });
    http.on('error', (err) => this.log(`server error: ${err.message}`));
    this.http = http;
    this.wss = wss;
    this.boundPort = (http.address() as AddressInfo).port;
    return this.boundPort;
  }

  /** Called on pair, unpair, replacement, and permission or tool-list changes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The paired tab, or null. */
  tab(): TabSnapshot | null {
    const s = this.active;
    if (!s) return null;
    return { sessionId: s.id, permission: this.effectivePermission(s), tools: s.tools, client: s.client, connectedAt: s.connectedAt };
  }

  /** The live pairing code, minting one if none is live. */
  pairingCode(): string {
    return this.pairing.current();
  }

  /** Retire any live code and mint a fresh one (to pair a replacement tab). */
  rotatePairingCode(): string {
    return this.pairing.rotate();
  }

  pairingUrl(code: string): string {
    return buildPairingUrl(this.opts.viewerUrl, this.boundPort, code);
  }

  /** Forward a tool call to the paired tab. Rejects with {@link BridgeCallError}. */
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeCallResult> {
    const s = this.active;
    if (this.closing) return Promise.reject(new BridgeCallError('shutting-down', 'The bridge is shutting down.'));
    if (!s) {
      return Promise.reject(new BridgeCallError('no-viewer', 'No connected viewer: no ifc-lite browser tab is paired with this bridge.'));
    }
    const tool = s.tools.find((t) => t.name === name);
    if (!tool) return Promise.reject(new BridgeCallError('unknown-tool', `The connected viewer does not offer a tool named '${name}'.`));
    if (!tool.readOnly && this.effectivePermission(s) === 'read-only') {
      return Promise.reject(new BridgeCallError(
        'read-only',
        this.opts.readOnlyCeiling
          ? `'${name}' changes the model, and this bridge was started --read-only.`
          : `'${name}' changes the model, and the viewer granted read-only access. Allow changes in the tab to use it.`,
      ));
    }
    return s.call(name, args, this.callTimeoutMs, signal);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const ws of this.handshaking) failSocket(ws, BridgeErrorCode.SHUTTING_DOWN, 'The bridge is shutting down.', BridgeCloseCode.SHUTTING_DOWN, this.log);
    this.handshaking.clear();
    const s = this.active;
    if (s) {
      this.active = null;
      s.failAll('shutting-down', 'The bridge is shutting down.');
      failSocket(s.ws, BridgeErrorCode.SHUTTING_DOWN, 'The bridge is shutting down.', BridgeCloseCode.SHUTTING_DOWN, this.log);
    }
    const wss = this.wss;
    if (wss && wss.clients.size > 0) {
      // Let the close frames go out, then drop any peer that has not answered.
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const c of wss.clients) c.terminate();
    }
    wss?.close();
    const http = this.http;
    this.http = null;
    if (http) {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }

  // ── connection handling ──────────────────────────────────────────────

  private onUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', (err) => this.log(`upgrade socket error: ${err.message}`));
    const refuse = (status: number, text: string, why: string): void => {
      this.log(`refused a connection: ${why}`);
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (!hostAllowed(req.headers.host, this.boundPort)) {
      return refuse(403, 'Forbidden', `Host ${JSON.stringify(req.headers.host)} is not loopback on port ${this.boundPort}`);
    }
    if (!originAllowed(req.headers.origin, this.origins)) {
      return refuse(403, 'Forbidden', `Origin ${JSON.stringify(req.headers.origin)} is not allowed`);
    }
    if (this.closing) return refuse(503, 'Service Unavailable', 'shutting down');
    if (this.handshaking.size >= this.maxPendingHandshakes) return refuse(429, 'Too Many Requests', 'too many unpaired connections');
    wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
  }

  private onSocket(ws: WebSocket): void {
    this.handshaking.add(ws);
    let session: BridgeSession | null = null;
    let greeted = false;
    const handshakeTimer = setTimeout(() => {
      failSocket(ws, BridgeErrorCode.HANDSHAKE_TIMEOUT, 'No hello within the handshake timeout.', BridgeCloseCode.HANDSHAKE_TIMEOUT, this.log);
    }, this.handshakeTimeoutMs);

    ws.on('error', (err) => this.log(`socket error: ${err.message}`));
    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      this.handshaking.delete(ws);
      if (session && this.active === session) this.unpair(session);
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        failSocket(ws, BridgeErrorCode.INVALID_MESSAGE, 'Binary frames are not part of the protocol.', BridgeCloseCode.INVALID_MESSAGE, this.log);
        return;
      }
      const text = rawToString(data);
      if (!greeted) {
        greeted = true;
        clearTimeout(handshakeTimer);
        session = this.handshake(ws, text);
        return;
      }
      if (session && this.active === session) this.onSessionMessage(session, text);
    });
  }

  private handshake(ws: WebSocket, text: string): BridgeSession | null {
    const reject = (code: BridgeErrorCode, message: string, closeCode: number): null => {
      failSocket(ws, code, message, closeCode, this.log);
      return null;
    };
    const parsed = parseTabMessage(text);
    if (!parsed.ok || parsed.value.type !== 'hello') {
      const why = parsed.ok ? `expected hello, got ${parsed.value.type}` : parsed.error;
      return reject(BridgeErrorCode.INVALID_MESSAGE, `First message must be a valid hello: ${why}`, BridgeCloseCode.INVALID_MESSAGE);
    }
    const hello = parsed.value;
    // Checked before the code, so a stale tab does not burn the user's code.
    if (hello.protocol !== BRIDGE_PROTOCOL_VERSION) {
      return reject(
        BridgeErrorCode.PROTOCOL_VERSION_MISMATCH,
        `This bridge speaks protocol ${BRIDGE_PROTOCOL_VERSION}; the tab sent ${hello.protocol}. Update @ifc-lite/mcp or reload the viewer.`,
        BridgeCloseCode.PROTOCOL_VERSION_MISMATCH,
      );
    }
    const check = this.pairing.consume(hello.pairingCode);
    if (check !== 'ok') {
      return reject(
        BridgeErrorCode.PAIRING_FAILED,
        check === 'no-code'
          ? 'No pairing code is live (a tab is already paired). Ask the agent to call bridge_status with pair_new_tab for a fresh link.'
          : 'Pairing code not accepted. Use the latest link or code from bridge_status.',
        BridgeCloseCode.PAIRING_FAILED,
      );
    }
    this.handshaking.delete(ws);
    const previous = this.active;
    const session = new BridgeSession(ws, randomUUID(), hello.permission, hello.tools, hello.client, this.log);
    this.active = session;
    if (previous) {
      previous.failAll('replaced', 'Another viewer tab was paired and replaced this one before it answered.');
      failSocket(previous.ws, BridgeErrorCode.REPLACED, 'Another tab was paired with this bridge.', BridgeCloseCode.REPLACED, this.log);
    }
    session.send({
      type: 'welcome',
      protocol: BRIDGE_PROTOCOL_VERSION,
      sessionId: session.id,
      permission: this.effectivePermission(session),
      readOnlyCeiling: this.opts.readOnlyCeiling,
      bridge: this.opts.bridgeInfo,
    });
    const who = hello.client ? `${hello.client.name}${hello.client.version ? ` ${hello.client.version}` : ''}` : 'a viewer tab';
    this.log(`paired with ${who}${previous ? ' (replaced the previous tab)' : ''}: ${hello.tools.length} tools, ${this.effectivePermission(session)}`);
    this.emitChange();
    return session;
  }

  private onSessionMessage(s: BridgeSession, text: string): void {
    const parsed = parseTabMessage(text);
    if (!parsed.ok) {
      // A malformed reply to a pending call fails that call now, not at its timeout.
      const id = looseId(text, s.id);
      if (id !== null) s.failOne(id, 'malformed-result', (name) => `The viewer sent a malformed reply to '${name}': ${parsed.error}`);
      s.send({ type: 'error', code: BridgeErrorCode.INVALID_MESSAGE, message: parsed.error });
      return;
    }
    const msg = parsed.value;
    if (msg.type === 'hello') {
      s.send({ type: 'error', code: BridgeErrorCode.INVALID_MESSAGE, message: 'Already paired; hello is only valid as the first message.' });
      return;
    }
    if (msg.sessionId !== s.id) {
      this.log(`ignored a ${msg.type} naming another session`);
      return;
    }
    if (msg.type === 'result') {
      if (!s.settle(msg.id, msg.result)) this.log(`ignored a result for call ${msg.id}: not pending (unknown, answered or expired)`);
      return;
    }
    const before = this.effectivePermission(s);
    if (msg.permission !== undefined) s.tabPermission = msg.permission;
    if (msg.tools !== undefined) s.tools = msg.tools;
    const after = this.effectivePermission(s);
    if (before !== after) this.log(`viewer permission is now ${after}`);
    this.emitChange();
  }

  /** The paired tab's socket closed: fail its calls and offer a fresh pairing link. */
  private unpair(s: BridgeSession): void {
    this.active = null;
    s.failAll('disconnected', 'The viewer tab disconnected before answering.');
    if (this.closing) return;
    this.log(`viewer disconnected. To pair again open ${this.pairingUrl(this.pairing.current())}`);
    this.emitChange();
  }

  private effectivePermission(s: BridgeSession): BridgePermission {
    return this.opts.readOnlyCeiling ? 'read-only' : s.tabPermission;
  }

  private emitChange(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        this.log(`change listener failed: ${(err as Error).message}`);
      }
    }
  }
}
