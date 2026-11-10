/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WebSocket } from 'ws';

/** Send to an open peer; a send error is logged, never thrown into the room. */
export function safeSend(ws: WebSocket, data: Uint8Array): void {
  try {
    if (ws.readyState === ws.OPEN) ws.send(data);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[collab-server] ws send error:', err);
  }
}
