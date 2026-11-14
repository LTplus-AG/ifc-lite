/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tab's end of `ifc-lite-mcp --bridge` (#9523): one WebSocket to the
 * bridge on this computer, serving the tools it announced at pairing.
 *
 *   tab -> hello { read-only, tools }      bridge -> welcome { sessionId, readOnlyCeiling }
 *   bridge -> call { id, name, arguments }  tab -> result { id, result }
 *   bridge -> cancel { id }                 (the call's AbortSignal fires; no result is sent)
 *   tab -> update { permission, tools }     (the user allowed or stopped edits)
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
 *   - Calls are admitted by `CallAdmission`: a few run at once, each with a
 *     tab-side time limit; a peer that floods is disconnected.
 *   - The activity log records tool, model, duration and outcome per call,
 *     never arguments or results (an applied edit's row says what changed).
 *   - Every pairing starts read-only. `setPermission` is the only way to
 *     grant edits; `canEditNow()` is what the tab's own dispatcher asks
 *     before it writes, so the grant is enforced here, not only by the
 *     bridge. A revoke takes effect at once for every call not yet written:
 *     each edit checks the grant synchronously with its write.
 */

import {
  BRIDGE_LIMITS,
  BRIDGE_PROTOCOL_VERSION,
  normalizePairingCode,
  parseServerMessage,
  parseTabMessage,
  type BridgeHelloMessage,
  type BridgeToolDescriptor,
  type BridgeUpdateMessage,
} from '@ifc-lite/mcp/bridge-protocol';
import type {
  AgentBridgeActivity, AgentBridgePermission, AgentBridgeStatus,
} from './state';
import type { ToolOutcome } from './result-frame';
import { CALL_LIMITS, type CallLimits } from './call-admission';
import { CallRunner } from './call-runner';
import { WELCOME_TIMEOUT_CLOSE, statusForClose } from './close-outcome';


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

/**
 * The bridge answers a wrong code after a backoff of up to 5 s, so the tab
 * waits well past that before calling the handshake lost.
 */
export const DEFAULT_WELCOME_TIMEOUT_MS = 15_000;

/** What the browser says about loopback access for this site. */
export type LocalNetworkPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface BridgeClientOptions {
  port: number;
  pairingCode: string;
  /**
   * The tools announced in `hello` and in every `update`. Tools labelled
   * `readOnly: false` are refused by the bridge (and by `dispatch`, which
   * must ask `canEditNow()`) until the user grants `read-write`.
   */
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
  /** Asked after a connection that never opened: the browser's `loopback-network` permission, to tell "denied" or "prompt pending" from "not running". */
  probePermission?: () => Promise<LocalNetworkPermission>;
  welcomeTimeoutMs?: number;
  /** Defaults to `BRIDGE_LIMITS.maxResultBytes`. */
  maxResultBytes?: number;
  now?: () => number;
  /** Test seam over {@link CALL_LIMITS}. */
  limits?: Partial<CallLimits>;
}


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
  private readonly limits: CallLimits;
  private runner: CallRunner | null = null;
  private current: AgentBridgeStatus = { kind: 'idle' };
  private readonly mutating: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly lifecycle: BridgeClientOptions['lifecycle'];
  private readonly onPageHide = (): void => this.end({ kind: 'disconnected', reason: 'page-hidden' }, 1001, 'page hidden');

  constructor(private readonly opts: BridgeClientOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.limits = { ...CALL_LIMITS, ...opts.limits };
    this.lifecycle = opts.lifecycle !== undefined ? opts.lifecycle : (typeof window === 'undefined' ? null : window);
    this.mutating = new Set(opts.tools.filter((tool) => !tool.readOnly).map((tool) => tool.name));
  }

  get status(): AgentBridgeStatus {
    return this.current;
  }

  /** True only while paired and the user has allowed edits (and the bridge allows them). */
  canEditNow(): boolean {
    return this.current.kind === 'connected' && this.current.permission === 'read-write' && !this.current.readOnlyCeiling;
  }

  /**
   * Grant (`read-write`) or revoke (`read-only`) edits on the live session,
   * and tell the bridge with an `update` carrying the permission and the tool
   * list. The tab's own grant changes first and synchronously, so a revoke
   * refuses every edit not yet written even if the update is lost. Returns
   * false when nothing changed (not paired, already so, or a grant the
   * bridge's `--read-only` ceiling forbids).
   */
  setPermission(permission: AgentBridgePermission): boolean {
    const status = this.current;
    // `connected` holds only between welcome and the end, so the socket and session id are set.
    if (status.kind !== 'connected' || !this.ws || !this.sessionId) return false;
    if (permission === status.permission || (permission === 'read-write' && status.readOnlyCeiling)) return false;
    const ws = this.ws;
    const update: BridgeUpdateMessage = { type: 'update', sessionId: this.sessionId, permission, tools: [...this.opts.tools] };
    const json = JSON.stringify(update);
    // The bridge refuses an invalid update with an error frame that does not
    // say which frame it was, so the tab would show a grant the bridge never
    // applied. Check with the bridge's own validator first: an update it
    // would refuse grants nothing (a revoke still applies in the tab).
    const valid = parseTabMessage(json);
    if (!valid.ok) {
      warn(`the permission update would be refused by the bridge: ${valid.error}`);
      if (permission === 'read-write') return false;
    }
    // The tab's grant changes first: canEditNow() follows the status.
    this.setStatus({ ...status, permission });
    try {
      if (valid.ok) ws.send(json);
    } catch (err) {
      // Read-only still holds in the tab; a lost grant only means the bridge keeps refusing edits.
      warn('could not tell the bridge about the permission change', err);
    }
    return true;
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
    this.setStatus({ kind: 'connecting', port: this.opts.port, opened: true });
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
        this.runner = new CallRunner({
          sessionId: msg.sessionId,
          limits: this.limits,
          maxResultBytes: this.opts.maxResultBytes ?? BRIDGE_LIMITS.maxResultBytes,
          now: this.now,
          dispatch: this.opts.dispatch,
          modelIdFor: this.opts.modelIdFor,
          mutates: (name) => this.mutating.has(name),
          onActivity: this.opts.onActivity,
          send: (json) => ws.send(json),
          isLive: () => ws === this.ws && !this.ended && ws.readyState === OPEN,
          onFlood: () => this.end({ kind: 'disconnected', reason: 'flooded' }, 1008, 'too many calls'),
        });
        // Every pairing starts read-only, whatever the welcome says; only the user grants edits.
        this.setStatus({
          kind: 'connected', port: this.opts.port, permission: 'read-only', since: this.now(), readOnlyCeiling: msg.readOnlyCeiling,
        });
        return;
      }
      case 'call':
        if (!this.runner || msg.sessionId !== this.sessionId || this.runner.has(msg.id)) return;
        this.runner.admit(msg);
        return;
      case 'cancel':
        if (this.runner && msg.sessionId === this.sessionId) this.runner.cancel(msg.id);
        return;
      case 'error':
        if (this.sessionId) {
          // During a session an error frame is the bridge refusing one frame
          // of ours; it does not decide how a later close is reported. It does
          // not name the frame, so it cannot be tied to a grant; an `update` is
          // checked with the bridge's own validator before it is sent instead
          // (see setPermission).
          warn(`the bridge refused a frame: ${msg.code}: ${msg.message}`);
          return;
        }
        // Before welcome every error frame is fatal and followed by a close;
        // keep the code in case the close code is lost on the way.
        this.lastFrameError = msg.code;
        warn(`the bridge reported ${msg.code}: ${msg.message}`);
        return;
    }
  }

  private handleClose(ws: WebSocketLike, code: number): void {
    if (ws !== this.ws || this.ended) return;
    const port = this.opts.port;
    const status = statusForClose(code, { paired: this.sessionId !== null, opened: this.opened, frameError: this.lastFrameError, port });
    this.lastFrameError = null;
    this.end(status);
    // Never opened: only the browser can tell "permission denied" from "nothing listening".
    const probe = this.opts.probePermission;
    if (!this.opened && probe && status.kind === 'error' && status.code === 'unreachable') {
      void probe().then((permission) => {
        if (this.current.kind !== 'error' || this.current.code !== 'unreachable') return;
        if (permission === 'denied') this.setStatus({ kind: 'error', code: 'permission-denied', port });
        // A prompt still pending (Firefox times it out after ~5 min, closing 1006) or dismissed looks like "nothing listening".
        else if (permission === 'prompt') this.setStatus({ kind: 'error', code: 'unreachable', port, permission });
      }, (err: unknown) => warn('could not read the loopback-network permission', err));
    }
  }

  // ── calls ────────────────────────────────────────────────────────────

  // ── teardown ─────────────────────────────────────────────────────────

  /** Final state: abort every call, drop the socket, never reconnect. */
  private end(status: AgentBridgeStatus, closeCode?: number, closeReason?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.clearWelcomeTimer();
    this.lifecycle?.removeEventListener('pagehide', this.onPageHide);
    this.runner?.abortAll();
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
