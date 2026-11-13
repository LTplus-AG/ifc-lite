/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Whether the configured processing server is worth a request from this page. */

import type { IfcServerClient } from '@ifc-lite/server-client';

// Module-level cache: avoids repeated failed connection attempts.
let serverAvailabilityCache: { serverUrl: string; available: boolean; checkedAt: number } | null = null;
const SERVER_CHECK_CACHE_MS = 30000; // Re-check server availability every 30 seconds

/**
 * Check if the server URL is reachable from the current origin.
 *
 * The URL is absolute, or a same-origin path (`/ifc`) when a reverse proxy
 * serves the processing server beside the viewer. Returns false for a
 * localhost server seen from a non-localhost page (it would only log a CORS
 * error).
 */
export function isServerReachable(
  serverUrl: string,
  page: Pick<Location, 'href' | 'hostname'> | undefined = typeof window !== 'undefined' ? window.location : undefined,
): boolean {
  if (serverUrl === '') return false;
  try {
    const server = new URL(serverUrl, page?.href);
    const isLocalhost = (hostname: string) => hostname === 'localhost' || hostname === '127.0.0.1';
    return !(page && isLocalhost(server.hostname) && !isLocalhost(page.hostname));
  } catch {
    // Not a URL at all (or a path with no page to resolve it against): no server to ask.
    return false;
  }
}

/**
 * Silently check if the server is available (no console logging on failure).
 * Returns the cached result if recently checked.
 */
export async function isServerAvailable(serverUrl: string, client: IfcServerClient): Promise<boolean> {
  // First check if server is even reachable (prevents CORS errors)
  if (!isServerReachable(serverUrl)) {
    return false;
  }

  const now = Date.now();
  // The answer belongs to one server: a URL set at runtime is asked afresh.
  if (serverAvailabilityCache?.serverUrl === serverUrl && (now - serverAvailabilityCache.checkedAt) < SERVER_CHECK_CACHE_MS) {
    return serverAvailabilityCache.available;
  }

  try {
    await client.health();
    serverAvailabilityCache = { serverUrl, available: true, checkedAt: now };
    return true;
  } catch {
    // Silent failure - don't log network errors for unavailable server
    serverAvailabilityCache = { serverUrl, available: false, checkedAt: now };
    return false;
  }
}
