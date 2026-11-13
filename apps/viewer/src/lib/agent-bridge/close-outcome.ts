/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a closed bridge socket means for the user (#9523). Once paired, every
 * ending is a `disconnected` with a reason the UI shows; before pairing, the
 * close code (or the fatal `error` frame that preceded it) says what failed.
 */

import { BridgeCloseCode, BridgeErrorCode } from '@ifc-lite/mcp/bridge-protocol';
import type { AgentBridgeDisconnectReason, AgentBridgeErrorCode, AgentBridgeStatus } from './state';

/** Close code the tab uses when it gives up waiting for `welcome` (application range). */
export const WELCOME_TIMEOUT_CLOSE = 4008;

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

const DISCONNECT_REASONS = new Set<string>(['replaced', 'bridge-shutdown', 'connection-lost', 'page-hidden', 'flooded']);

export interface CloseContext {
  /** A welcome was received: the session had started. */
  paired: boolean;
  /** The socket opened (the hello went out). */
  opened: boolean;
  /** The code of a fatal `error` frame received before pairing, if any. */
  frameError: string | null;
  port: number;
}

export function statusForClose(code: number, ctx: CloseContext): AgentBridgeStatus {
  const { port } = ctx;
  if (ctx.paired) return { kind: 'disconnected', reason: ENDINGS[code] ?? 'connection-lost' };
  const fatal = FATAL_ERRORS[code];
  if (fatal) return { kind: 'error', code: fatal, port };
  const ending = ENDINGS[code];
  if (ending) return { kind: 'disconnected', reason: ending };
  const fromFrame = ctx.frameError ? FRAME_ERRORS[ctx.frameError] : undefined;
  if (fromFrame) {
    return DISCONNECT_REASONS.has(fromFrame)
      ? { kind: 'disconnected', reason: fromFrame as AgentBridgeDisconnectReason }
      : { kind: 'error', code: fromFrame as AgentBridgeErrorCode, port };
  }
  // Opened but dropped before welcome with no reason given (the bridge drops an
  // unpaired socket that sends too much as 1006; a pre-upgrade 429 looks the
  // same), or never opened at all: a failed connection either way.
  return { kind: 'error', code: 'unreachable', port };
}
