/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pairing link and code format of the bridge protocol (#9523).
 * Browser-safe: no `node:*` import. Re-exported by `bridge-protocol.ts`.
 */

import { BRIDGE_PROTOCOL_VERSION, PAIRING_FRAGMENT_KEY } from './protocol.js';

// ── pairing link ─────────────────────────────────────────────────────────

/** Canonical form of a pairing code: upper case, separators removed. */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

/**
 * The link the user opens to pair a tab. Port and code travel in the URL
 * FRAGMENT, which the browser never sends to the web server:
 *
 *   https://ifclite.com/#mcp-bridge=1&port=21517&code=ABCDE-FGHJK-MNPQR-STVWX
 *
 * `mcp-bridge` carries the protocol version. Parse with {@link parsePairingFragment}.
 */
export function buildPairingUrl(viewerUrl: string, port: number, code: string): string {
  const url = new URL(viewerUrl);
  const params = new URLSearchParams();
  params.set(PAIRING_FRAGMENT_KEY, String(BRIDGE_PROTOCOL_VERSION));
  params.set('port', String(port));
  params.set('code', code);
  url.hash = params.toString();
  return url.toString();
}

export interface PairingFragment {
  protocol: number;
  port: number;
  code: string;
}

/**
 * Read a pairing link's fragment (`location.hash`, with or without the
 * leading `#`). Returns null when it is not a pairing link or is malformed.
 * The tab should clear the fragment after reading it so the code does not
 * linger in history.
 */
export function parsePairingFragment(hash: string): PairingFragment | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const version = params.get(PAIRING_FRAGMENT_KEY);
  const port = Number(params.get('port'));
  const code = params.get('code');
  if (version === null || code === null || code.length === 0) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const protocol = Number(version);
  if (!Number.isInteger(protocol)) return null;
  return { protocol, port, code };
}
