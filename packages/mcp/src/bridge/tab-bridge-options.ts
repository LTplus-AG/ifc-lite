/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Options and snapshot types for `TabBridge` (#9523). */

import type { BridgePermission, BridgeToolDescriptor } from './bridge-protocol.js';

export interface TabBridgeOptions {
  /** Port to bind on 127.0.0.1; 0 picks a free one. */
  port: number;
  /** Browser origins allowed to connect (exact scheme://host[:port]). */
  allowedOrigins: readonly string[];
  /** `--read-only`: tools the tab labels mutating stay hidden and refused, whatever the tab grants. */
  readOnlyCeiling: boolean;
  /** Base of the pairing link. */
  viewerUrl: string;
  bridgeInfo: { name: string; version: string };
  callTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxMessageBytes?: number;
  /** First wrong-code delay; doubles per recent failure up to `pairingBackoffMaxMs`. */
  pairingBackoffBaseMs?: number;
  pairingBackoffMaxMs?: number;
  /** Unpaired sockets allowed at once; more are refused with 429. */
  maxPendingHandshakes?: number;
  /** Window for coalescing repeated log lines. */
  logWindowMs?: number;
  /** Minimum interval between change notifications. */
  changeThrottleMs?: number;
  /** How long a failed socket gets to complete the close handshake before it is terminated. */
  closeGraceMs?: number;
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
export const DEFAULT_CLOSE_GRACE_MS = 250;
