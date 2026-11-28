/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BridgeToolDescriptor } from '@ifc-lite/mcp/bridge-protocol';
import type { DeliveryClaim } from '../agent-tools/delivery';
import type { ToolOutcome } from './result-frame';
import type { CallLimits } from './call-admission';
import type { AgentBridgeStatus, AgentBridgeActivity } from './state';
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
  onRefusedEvent?(): void;
  authenticate?: { resume: boolean; pendingNonce?: string; prepared?(rotationNonce: string, next: string): void; accepted(next: string): void };
  /**
   * The tools announced in `hello` and in every `update`. Tools labelled
   * `readOnly: false` are refused by the bridge (and by `dispatch`, which
   * must ask `canEditNow()`) until the user grants `read-write`.
   */
  tools: readonly BridgeToolDescriptor[];
  /** Runs one call. Must not throw (a throw is still caught and reported as INTERNAL_ERROR). */
  dispatch(name: string, args: Record<string, unknown>, signal: AbortSignal, onDelivery?: (claim: DeliveryClaim) => void): Promise<ToolOutcome>;
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
