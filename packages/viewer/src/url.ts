/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer server's address, with no dependencies, so clients can import
 * it (`@ifc-lite/viewer-core/url`) without loading the server and its HTML.
 */

/**
 * The address the viewer server binds. Clients dial it rather than
 * `localhost`, which may resolve to ::1, where another process can hold the
 * same port.
 */
export const VIEWER_HOST = '127.0.0.1';

/** `http://127.0.0.1:<port><path>`: the viewer server's own URL. */
export function viewerUrl(port: number, path = ''): string {
  return `http://${VIEWER_HOST}:${port}${path}`;
}
