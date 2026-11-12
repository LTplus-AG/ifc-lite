/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pairing link's first touch (#9523). `ifc-lite-mcp --bridge` prints
 *
 *   https://ifclite.com/#mcp-bridge=1&port=21517&code=ABCDE-FGHJK-MNPQR-STVWX
 *
 * The one-time code must not linger in the address bar, the history entry or
 * anything that reads `location` later (analytics, share links), so the
 * bootstrap calls {@link takePairingFragment} before any other viewer module
 * runs. It only recognises and removes the fragment; it does not parse the
 * code, open a socket or import the bridge client. Parsing and the user's
 * confirmation happen in the lazily loaded connect dialog.
 *
 * Eager by design, so this module imports nothing. The key is the bridge
 * protocol's `PAIRING_FRAGMENT_KEY` (a test pins the two together).
 */

const PAIRING_KEY = 'mcp-bridge';

let pending: string | null = null;

interface LocationLike { pathname: string; search: string; hash: string }
interface HistoryLike { state: unknown; replaceState(data: unknown, unused: string, url?: string): void }

/**
 * If `loc.hash` is a pairing link, remove the fragment from the current
 * history entry (path and query stay as they are) and keep its text in memory
 * for the connect dialog. Returns the fragment, or null for any other URL.
 */
export function takePairingFragment(loc: LocationLike, history: HistoryLike): string | null {
  const hash = loc.hash;
  if (hash.length < 2 || !new URLSearchParams(hash.slice(1)).has(PAIRING_KEY)) return null;
  try {
    history.replaceState(history.state, '', `${loc.pathname}${loc.search}`);
  } catch (err) {
    // A sandboxed or opaque-origin document can refuse replaceState. The link
    // is still honoured (the user still has to confirm), but say why the code
    // stayed visible.
    console.warn('[agent-bridge] could not remove the pairing code from the address bar', err);
  }
  pending = hash;
  return hash;
}

/** The pairing fragment taken at boot, handed out once. */
export function consumePendingPairingFragment(): string | null {
  const fragment = pending;
  pending = null;
  return fragment;
}
