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
 *     within the handshake timeout. See `pairing.ts`. Wrong codes are answered
 *     after a growing delay (`PairingBackoff`).
 *   - A socket that failed or timed out is dead: every later frame from it is
 *     ignored, its unpaired slot is freed at once, and it is terminated after
 *     a short grace even if the peer ignores the close frame.
 *   - One tab at a time. A new successful pairing REPLACES the paired tab:
 *     the old socket gets a `REPLACED` error and is closed, and its pending
 *     calls fail at once with reason `replaced`.
 *   - Tools the tab labels mutating are not forwarded while the effective
 *     permission is read-only (the tab's grant, capped by `--read-only`). The
 *     label is the tab's; the tab must enforce read-only itself too.
 *   - Repeated log lines are coalesced; tool-list changes are signalled only
 *     on a real change, and at most once per throttle interval.
 *   - A pending call ends by reply, timeout, cancellation or socket close; it
 *     never waits on a tab that has gone. See `session.ts` for reply matching.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocketServer, WebSocket, RawData } from 'ws';
import { listenLoopback, refuseUpgrade } from './loopback-server.js';
import {
  BRIDGE_LIMITS,
  BRIDGE_PROTOCOL_VERSION,
  BridgeCloseCode,
  BridgeErrorCode,
  buildPairingUrl,
  parseTabMessage,
  type BridgeCallResult,
  type BridgePermission,
} from './bridge-protocol.js';
import { hostAllowed, normalizeOrigin, originAllowed } from './guards.js';
import { PairingCodes } from './pairing.js';
import {
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_CLOSE_GRACE_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  type TabBridgeOptions,
  type TabSnapshot,
} from './tab-bridge-options.js';
import { CoalescedLog, PairingBackoff, Throttle } from './rate-limits.js';
import { BridgeCallError, BridgeSession, failSocket, looseId, rawToString } from './session.js';

export { BridgeCallError, type BridgeCallFailure } from './session.js';

export { DEFAULT_CALL_TIMEOUT_MS, DEFAULT_CLOSE_GRACE_MS, DEFAULT_HANDSHAKE_TIMEOUT_MS, type TabBridgeOptions, type TabSnapshot } from './tab-bridge-options.js';

export class TabBridge {
  private readonly log: (line: string) => void;
  private readonly callTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly maxPendingHandshakes: number;
  private readonly closeGraceMs: number;
  private readonly origins = new Set<string>();
  private readonly pairing = new PairingCodes();
  private readonly backoff: PairingBackoff;
  private readonly noisy: CoalescedLog;
  private readonly changed: Throttle;
  /** Sockets that failed or timed out: nothing they send is processed again. */
  private readonly dead = new WeakSet<WebSocket>();
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
    this.closeGraceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.backoff = new PairingBackoff(opts.pairingBackoffBaseMs, opts.pairingBackoffMaxMs);
    this.noisy = new CoalescedLog(this.log, opts.logWindowMs);
    this.changed = new Throttle(() => this.emitChange(), opts.changeThrottleMs ?? 200);
    for (const o of opts.allowedOrigins) {
      const normal = normalizeOrigin(o);
      if (normal === null) throw new Error(`not an http(s) origin: ${o}`);
      this.origins.add(normal);
    }
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
    const maxPayload = this.opts.maxMessageBytes ?? BRIDGE_LIMITS.maxMessageBytes;
    const server = await listenLoopback(this.opts.port, maxPayload, (wss, req, socket, head) => this.onUpgrade(wss, req, socket, head), this.log);
    this.http = server.http;
    this.wss = server.wss;
    this.boundPort = server.port;
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
    this.changed.cancel();
    this.noisy.flush();
    for (const ws of [...this.handshaking]) this.kill(ws, BridgeErrorCode.SHUTTING_DOWN, 'The bridge is shutting down.', BridgeCloseCode.SHUTTING_DOWN);
    const s = this.active;
    if (s) {
      this.active = null;
      s.failAll('shutting-down', 'The bridge is shutting down.');
      this.kill(s.ws, BridgeErrorCode.SHUTTING_DOWN, 'The bridge is shutting down.', BridgeCloseCode.SHUTTING_DOWN);
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
      this.noisy.note('refused connections', `refused a connection: ${why}`);
      refuseUpgrade(socket, status, text);
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
      this.kill(ws, BridgeErrorCode.HANDSHAKE_TIMEOUT, 'No hello within the handshake timeout.', BridgeCloseCode.HANDSHAKE_TIMEOUT);
    }, this.handshakeTimeoutMs);

    ws.on('error', (err) => this.log(`socket error: ${err.message}`));
    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      this.handshaking.delete(ws);
      if (session && this.active === session) this.unpair(session);
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      // `ws` keeps delivering frames while CLOSING; a dead socket gets no say.
      if (this.dead.has(ws)) return;
      if (isBinary) {
        this.kill(ws, BridgeErrorCode.INVALID_MESSAGE, 'Binary frames are not part of the protocol.', BridgeCloseCode.INVALID_MESSAGE);
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
    const reject = (code: BridgeErrorCode, message: string, closeCode: number, delayMs = 0): null => {
      this.kill(ws, code, message, closeCode, delayMs);
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
    if (check === 'no-code') {
      // Nothing to guess while paired, so this does not feed the back-off.
      this.noisy.note('pairing attempts while paired', 'refused a pairing attempt: a tab is already paired and no code is live');
      return reject(
        BridgeErrorCode.PAIRING_FAILED,
        'No pairing code is live (a tab is already paired). Ask the agent to call bridge_status with pair_new_tab for a fresh link.',
        BridgeCloseCode.PAIRING_FAILED,
      );
    }
    if (check === 'wrong') {
      const delay = this.backoff.fail();
      this.noisy.note('wrong pairing codes', `refused a wrong pairing code (answered after ${delay} ms)`);
      return reject(BridgeErrorCode.PAIRING_FAILED, 'Pairing code not accepted. Use the latest link or code from bridge_status.', BridgeCloseCode.PAIRING_FAILED, delay);
    }
    this.backoff.succeed();
    this.handshaking.delete(ws);
    const previous = this.active;
    const session = new BridgeSession(ws, randomUUID(), hello.permission, hello.tools, hello.client, this.log);
    this.active = session;
    if (previous) {
      previous.failAll('replaced', 'Another viewer tab was paired and replaced this one before it answered.');
      this.kill(previous.ws, BridgeErrorCode.REPLACED, 'Another tab was paired with this bridge.', BridgeCloseCode.REPLACED);
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
    this.changed.fire();
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
      this.noisy.note('frames naming another session', `ignored a ${msg.type} naming another session`);
      return;
    }
    if (msg.type === 'result') {
      if (!s.settle(msg.id, msg.result)) this.noisy.note('stray results', `ignored a result for call ${msg.id}: not pending (unknown, answered or expired)`);
      return;
    }
    const before = this.effectivePermission(s);
    const toolsBefore = JSON.stringify(s.tools);
    if (msg.permission !== undefined) s.tabPermission = msg.permission;
    if (msg.tools !== undefined) s.tools = msg.tools;
    const after = this.effectivePermission(s);
    const toolsChanged = msg.tools !== undefined && JSON.stringify(msg.tools) !== toolsBefore;
    if (before !== after) this.log(`viewer permission is now ${after}`);
    if (before !== after || toolsChanged) this.changed.fire();
  }

  /**
   * Make `ws` dead now: later frames are ignored. After `delayMs` (the
   * pairing back-off) it frees its unpaired slot, gets the error frame and a
   * close, and is terminated `closeGraceMs` later if the peer has not closed.
   */
  private kill(ws: WebSocket, code: BridgeErrorCode, message: string, closeCode: number, delayMs = 0): void {
    if (this.dead.has(ws)) return;
    this.dead.add(ws);
    const finish = (): void => {
      this.handshaking.delete(ws);
      failSocket(ws, code, message, closeCode, this.log);
      const terminate = setTimeout(() => ws.terminate(), this.closeGraceMs);
      terminate.unref?.();
      ws.once('close', () => clearTimeout(terminate));
    };
    if (delayMs <= 0) {
      finish();
      return;
    }
    const later = setTimeout(finish, delayMs);
    later.unref?.();
    ws.once('close', () => clearTimeout(later));
  }

  /** The paired tab's socket closed: fail its calls and offer a fresh pairing link. */
  private unpair(s: BridgeSession): void {
    this.active = null;
    s.failAll('disconnected', 'The viewer tab disconnected before answering.');
    if (this.closing) return;
    this.log(`viewer disconnected. To pair again open ${this.pairingUrl(this.pairing.current())}`);
    this.changed.fire();
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
