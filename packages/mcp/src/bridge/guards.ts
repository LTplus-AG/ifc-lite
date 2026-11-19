/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Checks on the WebSocket upgrade request, applied before the socket opens.
 *
 * - Origin: a web page cannot forge its own Origin, so the allowlist keeps
 *   other sites' pages from reaching the bridge. A local process can send any
 *   Origin it likes; against those the pairing code is the authentication.
 * - Host: must name a loopback address on the bridge's own port. A page that
 *   rebinds its DNS name to 127.0.0.1 still sends its own name as Host, so it
 *   fails here even if its Origin were allowed.
 */

/** Lower-case scheme://host[:port] with no trailing slash, or null if `value` is not an http(s) origin. */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin.toLowerCase();
  } catch {
    // Not a URL: report "not an origin" to the caller, which rejects it.
    return null;
  }
}

export function originAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (origin === undefined) return false;
  const normal = normalizeOrigin(origin);
  return normal !== null && allowed.has(normal);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True when the Host header is `127.0.0.1`, `localhost` or `[::1]` with exactly `port`. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const lower = host.toLowerCase();
  const colon = lower.lastIndexOf(':');
  if (colon <= 0) return false;
  const name = lower.slice(0, colon);
  const portText = lower.slice(colon + 1);
  return LOOPBACK_HOSTS.has(name) && portText === String(port);
}

/** `localhost`, any 127.0.0.0/8 address, or `[::1]`, as `URL.hostname` spells them. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) && h.split('.').every((p) => Number(p) <= 255);
}

/**
 * True when `origin` (already an http(s) origin) is plain `http:` on a host
 * other than loopback. Such a page's script can be replaced by anyone on the
 * network path, who would then read the pairing code from the link's fragment.
 */
export function isInsecureRemoteOrigin(origin: string): boolean {
  const url = new URL(origin);
  return url.protocol === 'http:' && !isLoopbackHostname(url.hostname);
}
