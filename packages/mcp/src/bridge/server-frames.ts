/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tab's parser for frames FROM the bridge (#9523). Browser-safe.
 * Re-exported by `bridge-protocol.ts`.
 */

import type {
  BridgeCallMessage,
  BridgeCancelMessage,
  BridgeErrorMessage,
  BridgeServerMessage,
  BridgeWelcomeMessage,
  ParseResult,
} from './protocol.js';
import { clip, quoted } from './sanitize.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPermission(v: unknown): boolean {
  return v === 'read-only' || v === 'read-write';
}

/** Parse a frame from the bridge (for the tab). Lenient: checks `type` and the fields the tab acts on. */
export function parseServerMessage(text: string): ParseResult<BridgeServerMessage> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not JSON: ${clip((err as Error).message, 120)}` };
  }
  if (!isRecord(raw)) return { ok: false, error: 'message must be a JSON object' };
  switch (raw.type) {
    case 'welcome':
      if (typeof raw.sessionId !== 'string' || !isPermission(raw.permission)) return { ok: false, error: 'malformed welcome' };
      return { ok: true, value: raw as unknown as BridgeWelcomeMessage };
    case 'call':
      if (typeof raw.sessionId !== 'string' || typeof raw.id !== 'string' || typeof raw.name !== 'string' || !isRecord(raw.arguments)) {
        return { ok: false, error: 'malformed call' };
      }
      return { ok: true, value: raw as unknown as BridgeCallMessage };
    case 'cancel':
      if (typeof raw.sessionId !== 'string' || typeof raw.id !== 'string') return { ok: false, error: 'malformed cancel' };
      return { ok: true, value: raw as unknown as BridgeCancelMessage };
    case 'error':
      if (typeof raw.code !== 'string' || typeof raw.message !== 'string') return { ok: false, error: 'malformed error' };
      return { ok: true, value: raw as unknown as BridgeErrorMessage };
    default:
      return { ok: false, error: `unknown message type ${quoted(raw.type, 32)}` };
  }
}
