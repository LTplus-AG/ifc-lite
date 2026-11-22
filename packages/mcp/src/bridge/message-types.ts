/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BridgeCallResult, BridgeErrorCode, BridgePermission, BridgeToolDescriptor } from './protocol.js';

// ── tab -> bridge ────────────────────────────────────────────────────────

export interface BridgeHelloMessage {
  type: 'hello';
  protocol: number;
  /** The one-time code the bridge printed. Case and `-`/space separators are ignored. */
  pairingCode: string;
  permission: BridgePermission;
  tools: BridgeToolDescriptor[];
  client?: { name: string; version?: string };
  resultAck?: true;
}

export interface BridgeResultMessage {
  type: 'result';
  sessionId: string;
  /** The `id` of the `call` being answered. */
  id: string;
  result: BridgeCallResult;
  resultAck?: true;
}

export interface BridgeUpdateMessage {
  type: 'update';
  sessionId: string;
  permission?: BridgePermission;
  tools?: BridgeToolDescriptor[];
}

export type BridgeTabMessage = BridgeHelloMessage | BridgeResultMessage | BridgeUpdateMessage;

// ── bridge -> tab ────────────────────────────────────────────────────────

export interface BridgeWelcomeMessage {
  type: 'welcome';
  protocol: number;
  sessionId: string;
  /** Effective permission: the tab's grant, capped by the bridge's ceiling. */
  permission: BridgePermission;
  /**
   * True when the bridge was started `--read-only`. The tab MUST then refuse
   * every model-changing call itself (see the read-only obligation above).
   */
  readOnlyCeiling: boolean;
  bridge: { name: string; version: string };
  features?: string[];
  resultAck?: true;
}

export interface BridgeCallMessage {
  type: 'call';
  sessionId: string;
  /** Unique across the bridge process's lifetime, never reused. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface BridgeCancelMessage {
  type: 'cancel';
  sessionId: string;
  id: string;
  reason: 'cancelled' | 'timeout';
}

export interface BridgeErrorMessage {
  type: 'error';
  code: BridgeErrorCode;
  message: string;
}

export type BridgeServerMessage =
  | BridgeWelcomeMessage
  | BridgeCallMessage
  | BridgeCancelMessage
  | BridgeErrorMessage;

/** A negotiated acknowledgement for a result the tab marked for confirmation. */
export interface BridgeResultAckMessage {
  type: 'result-ack';
  sessionId: string;
  id: string;
  accepted: boolean;
}
