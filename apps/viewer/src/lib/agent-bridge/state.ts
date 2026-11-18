/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The local-agent bridge's UI state (#9523), kept in memory only: no storage,
 * no URL, nothing that outlives the tab.
 *
 * This module is on the viewer's eager path (the status-bar chip slot, the
 * dialog host and the pairing-link check read it), so it imports nothing but
 * React, which the entry already holds (and types, which compile away).
 * The client, the tool host and every dialog load with `import()` after the
 * user acts.
 */

import { useSyncExternalStore } from 'react';
import type { BridgePermission } from '@ifc-lite/mcp/bridge-protocol';
import type { AgentEdit } from '@/lib/agent-tools/types';

/** Why a paired connection ended without the user disconnecting. */
export type AgentBridgeDisconnectReason =
  /** Another tab paired with the same bridge and replaced this one (close 4409). */
  | 'replaced'
  /** The bridge process shut down (close 4503). */
  | 'bridge-shutdown'
  /** The socket dropped after pairing: the bridge crashed, the machine slept, the network stack reset. */
  | 'connection-lost'
  /** The tab is being unloaded (`pagehide`). */
  | 'page-hidden'
  /** The program on the port sent more calls than the viewer accepts and was disconnected. */
  | 'flooded';

/** Why a connection attempt failed before or during pairing. */
export type AgentBridgeErrorCode =
  /** Nothing answered on the port: the bridge is not running or uses another port. */
  | 'unreachable'
  /** The browser denied this site access to apps on this device (`loopback-network`). */
  | 'permission-denied'
  /** Wrong code, or a code that was already used (close 4401). */
  | 'pairing-failed'
  /** The bridge speaks another protocol version (close 4426). */
  | 'protocol-mismatch'
  /** The bridge got no hello in time, or the tab got no welcome in time (close 4408). */
  | 'handshake-timeout'
  /** The bridge refused a frame as malformed (close 4400). */
  | 'invalid-message'
  /** Too many unpaired connections are open on the bridge (close 4429). */
  | 'busy'
  /** The pairing link or code could not be read. */
  | 'invalid-link'
  /** The viewer is inside a frame, where it never connects. */
  | 'framed';

/** What the tab grants the agent: `read-only` (the default at every pairing) or `read-write` once the user allows edits. */
export type AgentBridgePermission = BridgePermission;

export type AgentBridgeStatus =
  | { kind: 'idle' }
  /** `opened`: the socket is open and the hello sent; until then the browser may be asking for permission. */
  | { kind: 'connecting'; port: number; opened?: boolean }
  | {
    kind: 'connected'; port: number; permission: AgentBridgePermission; since: number;
    /** The bridge was started `--read-only`: the tab cannot grant edits. */
    readOnlyCeiling: boolean;
  }
  | { kind: 'disconnected'; reason: AgentBridgeDisconnectReason }
  /**
   * `permission: 'prompt'`: a socket that never opened while the browser's
   * `loopback-network` permission is still at its prompt (pending or dismissed).
   */
  | { kind: 'error'; code: AgentBridgeErrorCode; port?: number; permission?: 'prompt' };

/** What an applied agent edit changed, for its activity row. */
export type AgentBridgeEdit = AgentEdit;

/**
 * One served call. Carries no arguments and no results: the log shows WHAT
 * the agent asked for and how it went. The one exception is an edit, whose
 * row says what it changed (the user must be able to see that).
 */
export interface AgentBridgeActivity {
  seq: number;
  tool: string;
  /** The model the call was routed to, when known; null for model-free tools. */
  modelId: string | null;
  startedAt: number;
  durationMs: number;
  outcome: 'ok' | 'error' | 'cancelled';
  /** The tool's error code (`MODEL_NOT_FOUND`, `CANCELLED`, ...), never its message. */
  errorCode?: string;
  /** The tool changes the model (the tab listed it `readOnly: false`), whether or not this call did. */
  mutating?: boolean;
  /** Set when an edit was applied (or found the value already there). */
  edit?: AgentBridgeEdit;
}

/** What opened the connect dialog. */
export type AgentBridgeDialogRequest =
  | { source: 'link'; fragment: string }
  | { source: 'manual' };

export interface AgentBridgeState {
  status: AgentBridgeStatus;
  dialog: AgentBridgeDialogRequest | null;
  activity: readonly AgentBridgeActivity[];
}

/** Activity rows kept; older rows drop off. */
export const AGENT_BRIDGE_ACTIVITY_LIMIT = 200;

const INITIAL: AgentBridgeState = { status: { kind: 'idle' }, dialog: null, activity: [] };
let state: AgentBridgeState = INITIAL;
const listeners = new Set<() => void>();

export function getAgentBridgeState(): AgentBridgeState {
  return state;
}

export function subscribeAgentBridge(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function updateAgentBridgeState(patch: Partial<AgentBridgeState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

/** Open the connect dialog (Sources panel, command palette, or a pairing link). */
export function requestAgentBridgeDialog(request: AgentBridgeDialogRequest): void {
  updateAgentBridgeState({ dialog: request });
}

export function closeAgentBridgeDialog(): void {
  if (state.dialog) updateAgentBridgeState({ dialog: null });
}

export function useAgentBridgeState(): AgentBridgeState {
  return useSyncExternalStore(subscribeAgentBridge, getAgentBridgeState, getAgentBridgeState);
}

/**
 * Disconnect and dismiss, registered by the session module when it loads (it
 * loads before any connection exists). Every surface that shows a live
 * connection calls these synchronously, without importing the session.
 */
export interface AgentBridgeControls {
  disconnect(): void;
  dismiss(): void;
  /** Grant or revoke edits on the live connection; ignored when there is none. */
  setPermission(permission: AgentBridgePermission): void;
}

let controls: AgentBridgeControls | null = null;

export function registerAgentBridgeControls(next: AgentBridgeControls): void {
  controls = next;
}

/** Close the live connection, if there is one. */
export function disconnectLiveAgentBridge(): void {
  if (controls) controls.disconnect();
  else updateAgentBridgeState({ status: { kind: 'idle' } });
}

/** Allow (`read-write`) or stop (`read-only`) agent edits on the live connection. */
export function setLiveAgentBridgePermission(permission: AgentBridgePermission): void {
  controls?.setPermission(permission);
}

/** Forget a finished connection's outcome. */
export function dismissAgentBridgeOutcome(): void {
  if (controls) controls.dismiss();
  else updateAgentBridgeState({ status: { kind: 'idle' }, activity: [] });
}

/** Test seam: back to the first-load state. */
export function resetAgentBridgeStateForTests(): void {
  state = INITIAL;
  for (const listener of [...listeners]) listener();
}
