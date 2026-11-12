/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The local-agent bridge's UI state (#9523), kept in memory only: no storage,
 * no URL, nothing that outlives the tab.
 *
 * This module is on the viewer's eager path (the status-bar chip slot, the
 * dialog host and the pairing-link check read it), so it imports nothing but
 * React, which the entry already holds.
 * The client, the tool host and every dialog load with `import()` after the
 * user acts.
 */

import { useSyncExternalStore } from 'react';

/** Why a paired connection ended without the user disconnecting. */
export type AgentBridgeDisconnectReason =
  /** Another tab paired with the same bridge and replaced this one (close 4409). */
  | 'replaced'
  /** The bridge process shut down (close 4503). */
  | 'bridge-shutdown'
  /** The socket dropped after pairing: the bridge crashed, the machine slept, the network stack reset. */
  | 'connection-lost'
  /** The tab is being unloaded (`pagehide`). */
  | 'page-hidden';

/** Why a connection attempt failed before or during pairing. */
export type AgentBridgeErrorCode =
  /** Nothing answered on the port: the bridge is not running or uses another port. */
  | 'unreachable'
  /** The browser's local network permission was denied for this site. */
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
  | 'invalid-link';

export type AgentBridgeStatus =
  | { kind: 'idle' }
  | { kind: 'connecting'; port: number }
  | { kind: 'connected'; port: number; permission: 'read-only'; since: number }
  | { kind: 'disconnected'; reason: AgentBridgeDisconnectReason }
  | { kind: 'error'; code: AgentBridgeErrorCode; port?: number };

/**
 * One served call. Deliberately carries no arguments and no results: the log
 * shows WHAT the agent asked for and how it went, never the model's content.
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

/** Test seam: back to the first-load state. */
export function resetAgentBridgeStateForTests(): void {
  state = INITIAL;
  for (const listener of [...listeners]) listener();
}
