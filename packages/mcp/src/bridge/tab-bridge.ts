/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The loopback WebSocket end of `--bridge` (#9523): one paired tab, tool calls
 * forwarded to it. Owns: loopback bind and upgrade guards (Host, Origin, slot
 * cap, pre-pairing byte cap); the hello within the handshake timeout and the
 * rate-limited code comparison (`PairingGate`); dead sockets (ignored, slot
 * freed, terminated after a grace); one tab at a time (a new pairing REPLACES
 * the old tab and fails its calls); refusing tools the tab labels mutating
 * while read-only (the tab enforces too); coalesced logs and throttled change
 * events. Listeners never throw: `guard` fails the socket instead. Reply
 * matching lives in `session.ts`, paired frames in `session-frames.ts`.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocketServer, WebSocket, RawData } from 'ws';
import { capUnpairedBytes, closeLoopback, listenLoopback, refuseUpgrade } from './loopback-server.js';
import {
  BRIDGE_LIMITS,
  BRIDGE_PROTOCOL_VERSION,
  BridgeCloseCode,
  BridgeErrorCode,
  buildPairingUrl,
  parseTabMessage,
  type BridgeCallResult,
  type BridgeHelloMessage,
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
  type PairingStats,
  type Slot,
} from './tab-bridge-options.js';
import { BLOCKED_LINE, ChangeSignal, CoalescedLog, PairingGate } from './rate-limits.js';
import { clip } from './sanitize.js';
import { describeThrown } from '../errors.js';
import { BridgeCallError, BridgeSession, failSocket, rawToString } from './session.js';
import { handleSessionFrame } from './session-frames.js';

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
  private readonly gate: PairingGate;
  private readonly noisy: CoalescedLog;
  private readonly changed: ChangeSignal;
  /** Sockets that failed or timed out: nothing they send is processed again. */
  private readonly dead = new WeakSet<WebSocket>();
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private boundPort = 0;
  private active: BridgeSession | null = null;
  /** Unpaired connections, each holding one of `maxPendingHandshakes` slots. */
  private readonly slots = new Set<Slot>();
  private readonly slotOf = new WeakMap<WebSocket, Slot>();
  private attempts = 0;
  private failedAttempts = 0;
  private refusedBusy = 0;
  private closing = false;
  private closed: Promise<void> | null = null;

  constructor(private readonly opts: TabBridgeOptions) {
    this.log = opts.log ?? (() => {});
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.maxPendingHandshakes = opts.maxPendingHandshakes ?? 4;
    this.closeGraceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.gate = new PairingGate(opts.pairingBackoffBaseMs, opts.pairingBackoffMaxMs);
    this.noisy = new CoalescedLog(this.log, opts.logWindowMs);
    this.changed = new ChangeSignal(opts.changeThrottleMs ?? 200, (err) => this.log(`change listener failed: ${describeThrown(err)}`));
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
    return this.changed.subscribe(listener);
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

  /** Comparisons, deferral, waiting attempts, failures, and 429s for busy slots (see `PairingStats`). */
  pairingStats(): PairingStats {
    let deferred = 0;
    for (const slot of this.slots) if (slot.held) deferred++;
    return { attempts: this.attempts, delayMs: this.gate.delay(), deferred, failedAttempts: this.failedAttempts, refusedBusy: this.refusedBusy };
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

  /** Close everything. Every caller gets the same in-flight promise, and it never rejects. */
  close(): Promise<void> {
    this.closed ??= this.shutdown();
    return this.closed;
  }

  private async shutdown(): Promise<void> {
    this.closing = true;
    try {
      this.changed.cancel();
      this.noisy.flush();
      // A copy: kill() deletes from `slots` while this loop runs.
      for (const slot of Array.from(this.slots)) {
        if (slot.ws) this.kill(slot.ws, BridgeErrorCode.SHUTTING_DOWN, 'The bridge is shutting down.', BridgeCloseCode.SHUTTING_DOWN);
        else slot.socket.destroy();
      }
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
    } catch (err) {
      // Shutdown must not reject (callers chain on it during exit); report and carry on.
      this.log(`error while closing: ${describeThrown(err)}`);
    } finally {
      // Whatever failed above, the listener must close so the port is freed.
      const http = this.http;
      this.http = null;
      if (http) await closeLoopback(http);
    }
  }

  // ── connection handling ──────────────────────────────────────────────

  private onUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', (err) => this.noisy.note('socket errors', `upgrade socket error: ${clip(err.message)}`));
    const refuse = (status: number, text: string, why: string): void => {
      this.noisy.note('refused connections', `refused a connection: ${why}`);
      refuseUpgrade(socket, status, text);
    };
    try {
      if (!hostAllowed(req.headers.host, this.boundPort)) {
        return refuse(403, 'Forbidden', `Host ${clip(req.headers.host, 80)} is not loopback on port ${this.boundPort}`);
      }
      if (!originAllowed(req.headers.origin, this.origins)) return refuse(403, 'Forbidden', `Origin ${clip(req.headers.origin, 80)} is not allowed`);
      if (this.closing) return refuse(503, 'Service Unavailable', 'shutting down');
      if (this.slots.size >= this.maxPendingHandshakes) {
        // Every slot busy: wrong codes being tried, or sockets held open without a hello.
        this.refusedBusy++;
        this.noisy.note('connections refused while pairing is blocked', BLOCKED_LINE);
        return refuseUpgrade(socket, 429, 'Too Many Requests');
      }
      const slot: Slot = { socket, ws: null, paired: false, held: false, bytes: head.length };
      this.slots.add(slot);
      capUnpairedBytes(socket, slot, BRIDGE_LIMITS.maxUnpairedBytes, () => {
        this.noisy.note('oversized unpaired connections', `dropped an unpaired connection after ${BRIDGE_LIMITS.maxUnpairedBytes} bytes`);
      });
      socket.once('close', () => { if (!slot.held) this.slots.delete(slot); });
      wss.handleUpgrade(req, socket, head, (ws) => this.guard(ws, 'connection', () => this.onSocket(ws, slot)));
    } catch (err) {
      this.noisy.note('internal errors', `internal error on an upgrade: ${clip(describeThrown(err))}`);
      socket.destroy();
    }
  }

  /** Run `fn`; an unexpected exception fails this socket and is logged, never thrown out of a listener. */
  private guard(ws: WebSocket, what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.noisy.note('internal errors', `internal error handling a ${what}: ${clip(describeThrown(err))}`);
      this.kill(ws, BridgeErrorCode.INVALID_MESSAGE, 'The bridge could not handle that frame.', BridgeCloseCode.INVALID_MESSAGE);
    }
  }

  private onSocket(ws: WebSocket, slot: Slot): void {
    slot.ws = ws;
    this.slotOf.set(ws, slot);
    let session: BridgeSession | null = null;
    let greeted = false;
    const handshakeTimer = setTimeout(() => this.guard(ws, 'timeout', () => {
      this.kill(ws, BridgeErrorCode.HANDSHAKE_TIMEOUT, 'No hello within the handshake timeout.', BridgeCloseCode.HANDSHAKE_TIMEOUT);
    }), this.handshakeTimeoutMs);
    handshakeTimer.unref?.();

    ws.on('error', (err) => this.noisy.note('socket errors', `socket error: ${clip(err.message)}`));
    ws.on('close', () => this.guard(ws, 'close', () => {
      clearTimeout(handshakeTimer);
      if (session && this.active === session) this.unpair(session);
    }));
    ws.on('message', (data: RawData, isBinary: boolean) => this.guard(ws, 'frame', () => {
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
        this.handshake(ws, slot, text, (s) => { session = s; });
        return;
      }
      if (session && this.active === session) this.onSessionMessage(session, text);
    }));
  }

  private handshake(ws: WebSocket, slot: Slot, text: string, paired: (s: BridgeSession) => void): void {
    const reject = (code: BridgeErrorCode, message: string, closeCode: number): void => this.kill(ws, code, message, closeCode);
    const parsed = parseTabMessage(text);
    if (!parsed.ok || parsed.value.type !== 'hello') {
      const why = parsed.ok ? `expected hello, got ${parsed.value.type}` : parsed.error;
      return reject(BridgeErrorCode.INVALID_MESSAGE, clip(`First message must be a valid hello: ${why}`, 300), BridgeCloseCode.INVALID_MESSAGE);
    }
    const hello = parsed.value;
    // Checked before the code, so a stale tab does not burn the user's code.
    if (hello.protocol !== BRIDGE_PROTOCOL_VERSION) {
      return reject(
        BridgeErrorCode.PROTOCOL_VERSION_MISMATCH,
        `This bridge speaks protocol ${BRIDGE_PROTOCOL_VERSION}; the tab sent ${clip(hello.protocol, 20)}. Update @ifc-lite/mcp or reload the viewer.`,
        BridgeCloseCode.PROTOCOL_VERSION_MISMATCH,
      );
    }
    if (!this.pairing.live()) {
      // Nothing to guess while paired, so this neither waits nor feeds the gate.
      this.noisy.note('pairing attempts while paired', 'refused a pairing attempt: a tab is already paired and no code is live');
      return reject(
        BridgeErrorCode.PAIRING_FAILED,
        'No pairing code is live (a tab is already paired). Ask the agent to call bridge_status with pair_new_tab for a fresh link.',
        BridgeCloseCode.PAIRING_FAILED,
      );
    }
    const delay = this.gate.delay();
    if (delay === 0) return this.compare(ws, slot, hello, paired);
    // During an attack every comparison waits; the slot stays taken even if the peer leaves.
    slot.held = true;
    const later = setTimeout(() => this.guard(ws, 'pairing attempt', () => {
      slot.held = false;
      this.compare(ws, slot, hello, paired);
    }), delay);
    later.unref?.();
  }

  private compare(ws: WebSocket, slot: Slot, hello: BridgeHelloMessage, paired: (s: BridgeSession) => void): void {
    this.attempts++;
    if (ws.readyState !== ws.OPEN) {
      // Left before its comparison: counts as a failed guess, and frees the slot only now.
      this.gate.fail();
      this.failedAttempts++;
      this.slots.delete(slot);
      return;
    }
    if (this.pairing.consume(hello.pairingCode) !== 'ok') {
      this.gate.fail();
      this.failedAttempts++;
      this.noisy.note('wrong pairing codes', 'refused a wrong pairing code');
      this.kill(ws, BridgeErrorCode.PAIRING_FAILED, 'Pairing code not accepted. Use the latest link or code from bridge_status.', BridgeCloseCode.PAIRING_FAILED);
      return;
    }
    this.gate.succeed();
    slot.paired = true;
    this.slots.delete(slot);
    const previous = this.active;
    const session = new BridgeSession(ws, randomUUID(), hello.permission, hello.tools, hello.client, this.log);
    this.active = session;
    paired(session);
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
    // client name/version were clipped to one line by the parser.
    const who = hello.client ? `${hello.client.name}${hello.client.version ? ` ${hello.client.version}` : ''}` : 'a viewer tab';
    this.log(`paired with ${who}${previous ? ' (replaced the previous tab)' : ''}: ${hello.tools.length} tools, ${this.effectivePermission(session)}`);
    this.changed.fire();
  }

  private onSessionMessage(s: BridgeSession, text: string): void {
    handleSessionFrame(s, text, {
      note: (kind, line) => this.noisy.note(kind, line),
      log: this.log,
      effectivePermission: () => this.effectivePermission(s),
      changed: () => this.changed.fire(),
    });
  }

  /** Dead now: later frames ignored, slot freed, error + close sent, terminated after `closeGraceMs`. */
  private kill(ws: WebSocket, code: BridgeErrorCode, message: string, closeCode: number): void {
    if (this.dead.has(ws)) return;
    this.dead.add(ws);
    const slot = this.slotOf.get(ws);
    if (slot && !slot.held) this.slots.delete(slot);
    failSocket(ws, code, message, closeCode, this.log);
    const terminate = setTimeout(() => ws.terminate(), this.closeGraceMs);
    terminate.unref?.();
    ws.once('close', () => clearTimeout(terminate));
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
}
