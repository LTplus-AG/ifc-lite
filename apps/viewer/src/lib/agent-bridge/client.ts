/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tab's end of `ifc-lite-mcp --bridge` (#9523): one WebSocket to the
 * bridge on this computer, serving the tools it announced at pairing.
 *
 *   tab -> hello { read-only, tools }      bridge -> welcome { sessionId }
 *   bridge -> call { id, name, arguments }  tab -> result { id, result }
 *   bridge -> cancel { id }                 (the call's AbortSignal fires; no result is sent)
 *
 * Rules this class owns:
 *   - It connects only when `connect()` is called, and only to 127.0.0.1.
 *   - Every frame from the bridge is checked with the protocol's own
 *     validator. Invalid frames, frames naming another session and calls that
 *     arrive before `welcome` are ignored without closing the socket.
 *   - Each call gets its own AbortController. `cancel`, the socket closing,
 *     `disconnect()` and `pagehide` abort it, and an aborted call's late
 *     result is not sent: the bridge has already settled it and would drop it.
 *   - A pairing code works once. After any drop the client stays
 *     `disconnected` (or `error`) and never retries with the old code; the
 *     user pairs again with a fresh link.
 *   - Nothing here throws into the event loop.
 *   - The activity log records tool, model, duration and outcome per call,
 *     never arguments or results.
 */

import {
  BRIDGE_LIMITS,
  BRIDGE_PROTOCOL_VERSION,
  BridgeCloseCode,
  BridgeErrorCode,
  normalizePairingCode,
  parseServerMessage,
  type BridgeCallMessage,
  type BridgeHelloMessage,
  type BridgeToolDescriptor,
} from '@ifc-lite/mcp/bridge-protocol';
import type {
  AgentBridgeActivity, AgentBridgeDisconnectReason, AgentBridgeErrorCode, AgentBridgeStatus,
} from './state';
import { buildResultFrame, toCallToolResult, type ToolOutcome } from './result-frame';

/** The subset of the browser `WebSocket` the client uses, so tests can inject a fake. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

/** `WebSocket.OPEN`; a constant so the client does not depend on the global. */
const OPEN = 1;

/** Close code the tab uses when it gives up waiting for `welcome` (application range). */
const WELCOME_TIMEOUT_CLOSE = 4008;

export const DEFAULT_WELCOME_TIMEOUT_MS = 10_000;

/** What the browser says about loopback access for this site. */
export type LocalNetworkPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface BridgeClientOptions {
  port: number;
  pairingCode: string;
  /** The tools announced in `hello`. Read-only tools only: this client grants `read-only`. */
  tools: readonly BridgeToolDescriptor[];
  /** Runs one call. Must not throw (a throw is still caught and reported as INTERNAL_ERROR). */
  dispatch(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome>;
  /** The model a call is about, for the activity log. */
  modelIdFor?(args: Record<string, unknown>): string | null;
  onStatus(status: AgentBridgeStatus): void;
  onActivity?(entry: AgentBridgeActivity): void;
  clientInfo?: { name: string; version?: string };
  /** Defaults to the global `WebSocket`. */
  WebSocket?: WebSocketConstructor;
  /** Where `pagehide` is observed; defaults to `window` when there is one. */
  lifecycle?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  /** Asked after a connection that never opened, to tell "denied" from "not running". */
  probePermission?: () => Promise<LocalNetworkPermission>;
  welcomeTimeoutMs?: number;
  maxMessageBytes?: number;
  now?: () => number;
}

interface InFlight {
  controller: AbortController;
  tool: string;
  modelId: string | null;
  startedAt: number;
}

const FATAL_ERRORS: Record<number, AgentBridgeErrorCode> = {
  [BridgeCloseCode.INVALID_MESSAGE]: 'invalid-message',
  [BridgeCloseCode.PAIRING_FAILED]: 'pairing-failed',
  [BridgeCloseCode.HANDSHAKE_TIMEOUT]: 'handshake-timeout',
  [BridgeCloseCode.PROTOCOL_VERSION_MISMATCH]: 'protocol-mismatch',
  [BridgeCloseCode.BUSY]: 'busy',
  [WELCOME_TIMEOUT_CLOSE]: 'handshake-timeout',
};

const ENDINGS: Record<number, AgentBridgeDisconnectReason> = {
  [BridgeCloseCode.REPLACED]: 'replaced',
  [BridgeCloseCode.SHUTTING_DOWN]: 'bridge-shutdown',
};

/** The same mapping for the `error` frame the bridge sends just before a fatal close. */
const FRAME_ERRORS: Partial<Record<string, AgentBridgeErrorCode | AgentBridgeDisconnectReason>> = {
  [BridgeErrorCode.INVALID_MESSAGE]: 'invalid-message',
  [BridgeErrorCode.PAIRING_FAILED]: 'pairing-failed',
  [BridgeErrorCode.HANDSHAKE_TIMEOUT]: 'handshake-timeout',
  [BridgeErrorCode.PROTOCOL_VERSION_MISMATCH]: 'protocol-mismatch',
  [BridgeErrorCode.BUSY]: 'busy',
  [BridgeErrorCode.REPLACED]: 'replaced',
  [BridgeErrorCode.SHUTTING_DOWN]: 'bridge-shutdown',
};

const DISCONNECT_REASONS = new Set<string>(['replaced', 'bridge-shutdown', 'connection-lost', 'page-hidden']);

function warn(message: string, err?: unknown): void {
  console.warn(`[agent-bridge] ${message}`, ...(err === undefined ? [] : [err]));
}

export class BridgeClient {
  private ws: WebSocketLike | null = null;
  private sessionId: string | null = null;
  private opened = false;
  private ended = false;
  private lastFrameError: string | null = null;
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inFlight = new Map<string, InFlight>();
  private seq = 0;
  private current: AgentBridgeStatus = { kind: 'idle' };
  private readonly now: () => number;
  private readonly lifecycle: BridgeClientOptions['lifecycle'];
  private readonly onPageHide = (): void => this.end({ kind: 'disconnected', reason: 'page-hidden' }, 1001, 'page hidden');

  constructor(private readonly opts: BridgeClientOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.lifecycle = opts.lifecycle !== undefined ? opts.lifecycle : (typeof window === 'undefined' ? null : window);
  }

  get status(): AgentBridgeStatus {
    return this.current;
  }

  /** Open the socket and pair. Call once per client: a used pairing code is never resent. */
  connect(): void {
    if (this.ws || this.ended) return;
    this.setStatus({ kind: 'connecting', port: this.opts.port });
    const Ctor = this.opts.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketConstructor | undefined);
    if (!Ctor) {
      this.end({ kind: 'error', code: 'unreachable', port: this.opts.port });
      return;
    }
    let ws: WebSocketLike;
    try {
      // 127.0.0.1, never `localhost`: no resolver involved, and it is the
      // Host the bridge expects.
      ws = new Ctor(`ws://127.0.0.1:${this.opts.port}/`);
    } catch (err) {
      // Thrown synchronously when the browser blocks the address outright.
      warn('the browser refused to open the connection', err);
      this.end({ kind: 'error', code: 'permission-denied', port: this.opts.port });
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.guard('open', () => this.handleOpen(ws));
    ws.onmessage = (event) => this.guard('message', () => this.handleMessage(ws, event.data));
    ws.onclose = (event) => this.guard('close', () => this.handleClose(ws, event.code));
    ws.onerror = () => { /* a close event always follows; it carries the outcome */ };
    this.lifecycle?.addEventListener('pagehide', this.onPageHide);
  }

  /** Close the connection at the user's request. In-flight calls are aborted and not answered. */
  disconnect(): void {
    this.end({ kind: 'idle' }, 1000, 'disconnected by the user');
  }

  // ── socket events ────────────────────────────────────────────────────

  private handleOpen(ws: WebSocketLike): void {
    if (ws !== this.ws) return;
    this.opened = true;
    const hello: BridgeHelloMessage = {
      type: 'hello',
      protocol: BRIDGE_PROTOCOL_VERSION,
      pairingCode: normalizePairingCode(this.opts.pairingCode),
      permission: 'read-only',
      tools: [...this.opts.tools],
      ...(this.opts.clientInfo ? { client: this.opts.clientInfo } : {}),
    };
    ws.send(JSON.stringify(hello));
    this.welcomeTimer = setTimeout(() => {
      this.welcomeTimer = null;
      if (!this.sessionId) this.end({ kind: 'error', code: 'handshake-timeout', port: this.opts.port }, WELCOME_TIMEOUT_CLOSE, 'no welcome');
    }, this.opts.welcomeTimeoutMs ?? DEFAULT_WELCOME_TIMEOUT_MS);
  }

  private handleMessage(ws: WebSocketLike, data: unknown): void {
    if (ws !== this.ws || this.ended) return;
    if (typeof data !== 'string') {
      warn('ignored a binary frame from the bridge');
      return;
    }
    const parsed = parseServerMessage(data);
    if (!parsed.ok) {
      warn(`ignored an invalid frame from the bridge: ${parsed.error}`);
      return;
    }
    const msg = parsed.value;
    switch (msg.type) {
      case 'welcome': {
        if (this.sessionId) return;
        if (msg.protocol !== BRIDGE_PROTOCOL_VERSION) {
          this.end({ kind: 'error', code: 'protocol-mismatch', port: this.opts.port }, 1000, 'protocol mismatch');
          return;
        }
        this.clearWelcomeTimer();
        this.sessionId = msg.sessionId;
        // This client only ever grants read-only, whatever the welcome says.
        this.setStatus({ kind: 'connected', port: this.opts.port, permission: 'read-only', since: this.now() });
        return;
      }
      case 'call':
        if (!this.sessionId || msg.sessionId !== this.sessionId) return;
        if (this.inFlight.has(msg.id)) return;
        void this.serve(ws, this.sessionId, msg);
        return;
      case 'cancel': {
        if (!this.sessionId || msg.sessionId !== this.sessionId) return;
        this.inFlight.get(msg.id)?.controller.abort();
        return;
      }
      case 'error':
        // Fatal errors are followed by a close that carries the outcome; keep
        // the code in case the close code is lost on the way.
        this.lastFrameError = msg.code;
        warn(`the bridge reported ${msg.code}: ${msg.message}`);
        return;
    }
  }

  private handleClose(ws: WebSocketLike, code: number): void {
    if (ws !== this.ws || this.ended) return;
    const port = this.opts.port;
    const fatal = FATAL_ERRORS[code];
    const ending = ENDINGS[code];
    if (fatal) return this.end({ kind: 'error', code: fatal, port });
    if (ending) return this.end({ kind: 'disconnected', reason: ending });
    const fromFrame = this.lastFrameError ? FRAME_ERRORS[this.lastFrameError] : undefined;
    if (fromFrame) {
      return this.end(DISCONNECT_REASONS.has(fromFrame)
        ? { kind: 'disconnected', reason: fromFrame as AgentBridgeDisconnectReason }
        : { kind: 'error', code: fromFrame as AgentBridgeErrorCode, port });
    }
    if (this.sessionId) return this.end({ kind: 'disconnected', reason: 'connection-lost' });
    if (this.opened) return this.end({ kind: 'error', code: 'handshake-timeout', port });
    // Never opened: nothing listening, an origin the bridge does not allow,
    // or the browser's local network permission said no. Only the browser
    // can tell the last one apart.
    this.end({ kind: 'error', code: 'unreachable', port });
    const probe = this.opts.probePermission;
    if (probe) {
      void probe().then((permission) => {
        if (permission === 'denied' && this.current.kind === 'error' && this.current.code === 'unreachable') {
          this.setStatus({ kind: 'error', code: 'permission-denied', port });
        }
      }, (err: unknown) => warn('could not read the local network permission', err));
    }
  }

  // ── calls ────────────────────────────────────────────────────────────

  private async serve(ws: WebSocketLike, sessionId: string, call: BridgeCallMessage): Promise<void> {
    const entry: InFlight = {
      controller: new AbortController(),
      tool: call.name,
      modelId: this.modelIdFor(call.arguments),
      startedAt: this.now(),
    };
    this.inFlight.set(call.id, entry);
    let outcome: ToolOutcome;
    try {
      outcome = await this.opts.dispatch(call.name, call.arguments, entry.controller.signal);
    } catch (err) {
      outcome = { text: err instanceof Error ? err.message : String(err), structured: null, isError: true, errorCode: 'INTERNAL_ERROR' };
    }
    const stillPending = this.inFlight.get(call.id) === entry;
    if (stillPending) this.inFlight.delete(call.id);
    const aborted = entry.controller.signal.aborted;
    this.record(entry, aborted ? { outcome: 'cancelled', errorCode: 'CANCELLED' }
      : outcome.isError ? { outcome: 'error', errorCode: outcome.errorCode ?? 'INTERNAL_ERROR' } : { outcome: 'ok' });
    // A cancelled call is already settled on the bridge, and a closed socket has no one to answer.
    if (aborted || !stillPending || ws !== this.ws || this.ended || ws.readyState !== OPEN) return;
    try {
      const frame = buildResultFrame(sessionId, call.id, toCallToolResult(outcome), this.opts.maxMessageBytes ?? BRIDGE_LIMITS.maxMessageBytes);
      if (frame.truncated) warn(`the result of ${call.name} was over the bridge's message limit and was truncated`);
      ws.send(frame.json);
    } catch (err) {
      warn(`could not send the result of ${call.name}`, err);
    }
  }

  private modelIdFor(args: Record<string, unknown>): string | null {
    try {
      return this.opts.modelIdFor?.(args) ?? null;
    } catch (err) {
      warn('could not tell which model a call is about', err);
      return null;
    }
  }

  private record(entry: InFlight, result: Pick<AgentBridgeActivity, 'outcome' | 'errorCode'>): void {
    const row: AgentBridgeActivity = {
      seq: ++this.seq,
      tool: entry.tool,
      modelId: entry.modelId,
      startedAt: entry.startedAt,
      durationMs: Math.max(0, this.now() - entry.startedAt),
      ...result,
    };
    try {
      this.opts.onActivity?.(row);
    } catch (err) {
      warn('the activity listener failed', err);
    }
  }

  // ── teardown ─────────────────────────────────────────────────────────

  /** Final state: abort every call, drop the socket, never reconnect. */
  private end(status: AgentBridgeStatus, closeCode?: number, closeReason?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.clearWelcomeTimer();
    this.lifecycle?.removeEventListener('pagehide', this.onPageHide);
    for (const call of this.inFlight.values()) call.controller.abort();
    this.inFlight.clear();
    const ws = this.ws;
    if (ws && closeCode !== undefined) {
      try {
        ws.close(closeCode, closeReason);
      } catch (err) {
        warn('closing the socket failed', err);
      }
    }
    this.setStatus(status);
  }

  private clearWelcomeTimer(): void {
    if (this.welcomeTimer !== null) clearTimeout(this.welcomeTimer);
    this.welcomeTimer = null;
  }

  private setStatus(status: AgentBridgeStatus): void {
    this.current = status;
    try {
      this.opts.onStatus(status);
    } catch (err) {
      warn('the status listener failed', err);
    }
  }

  private guard(what: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      warn(`a ${what} event failed`, err);
    }
  }
}
