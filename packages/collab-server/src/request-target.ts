/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parsing of the request target (`req.url`), which the client controls.
 *
 * `new URL(target, base)` throws `TypeError` for targets such as `//`, and
 * `decodeURIComponent` throws `URIError` for a malformed percent-escape such
 * as `%E0%A4%A`. Both are errors in ONE client's request, so they are
 * returned as `null` for the caller to answer (400 / close 4400) instead of
 * being thrown into a handler that reports them as a server fault.
 */

/** Parse a request target against a placeholder origin; null if `new URL` rejects it. */
export function parseRequestUrl(target: string | undefined): URL | null {
  try {
    return new URL(target ?? '/', 'http://localhost');
  } catch {
    return null;
  }
}

/**
 * The URL and room id of a websocket upgrade. y-websocket convention: the room
 * id is the path (e.g. `ws://host/project/model`). Null when the target does
 * not parse or its path is not a well-formed percent-encoding.
 */
export function parseRoomRequest(target: string | undefined): { url: URL; roomId: string } | null {
  const url = parseRequestUrl(target);
  if (!url) return null;
  try {
    return { url, roomId: decodeURIComponent(url.pathname.replace(/^\/+/, '')) };
  } catch {
    return null;
  }
}
