/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Principal.expiresAt` re-check (#3441).
 *
 * `auth.ts` documents `expiresAt` as "checked again every 5 minutes per
 * spec" and `room-token.ts` populates it from a room token's `exp` claim,
 * but neither is enough on its own to make an established session lose
 * access when its credential expires — something has to actually compare
 * it against the clock. Two call sites do, for different exposure:
 *   - `Room.preCheckWriteFrame` (room-manager.ts) checks `isPrincipalExpired`
 *     immediately, on every write attempt — closes the gap `sweepMs` below
 *     leaves between sweeps.
 *   - `RoomManager.sweepExpiredPrincipals` (room-manager.ts), driven by the
 *     `EXPIRY_SWEEP_INTERVAL_MS` timer in `server.ts`, closes sockets whose
 *     `expiresAt` has passed so read + presence access stops too, not only
 *     writes.
 */

import type { WebSocket } from 'ws';
import type { Principal } from './auth.js';
import { DEFAULT_CLOCK_TOLERANCE_SEC } from './room-token.js';

/**
 * Clock-skew tolerance applied when comparing `Principal.expiresAt` against
 * the current time. Reuses `verifyRoomToken`'s own tolerance (the same
 * clock, the same `exp` claim `expiresAt` was derived from) instead of a
 * second, potentially-drifting constant.
 */
export const EXPIRY_CLOCK_TOLERANCE_MS = DEFAULT_CLOCK_TOLERANCE_SEC * 1000;

/**
 * Period of the periodic re-check sweep, matching the "every 5 minutes"
 * documented on `Principal.expiresAt`.
 */
export const EXPIRY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** The two failures a periodic expiry sweep can observe without aborting every other room. */
export type ExpirySweepFailure = 'close' | 'room-load';

/** Injectable so callers and behavioral tests can observe a failure rather than losing it in a catch. */
export type ExpirySweepErrorReporter = (kind: ExpirySweepFailure, error: unknown) => void;

const reportExpirySweepError: ExpirySweepErrorReporter = (kind, error) => {
  // eslint-disable-next-line no-console
  console.error(`[collab-server] expiry sweep ${kind} error:`, error);
};

/** Whether `expiresAt` (ms since epoch), if set, has passed `now` (ms). */
export function isPrincipalExpired(principal: Principal, now: number): boolean {
  return principal.expiresAt !== undefined && now >= principal.expiresAt + EXPIRY_CLOCK_TOLERANCE_MS;
}

/**
 * Close every connection whose principal has expired. Shared by
 * `Room.sweepExpiredPrincipals`; kept generic (name + ws + principal) rather
 * than importing `PeerConnection` to avoid a cycle with room-manager.ts.
 * Uses the same close-and-let-the-caller's-`ws.on('close', ...)`-listener
 * clean up pattern as an explicit admin kick (`Room.kickClient`). Returns
 * the number of connections closed.
 */
export function closeExpiredConnections<C extends { ws: WebSocket; principal: Principal }>(
  conns: Iterable<C>,
  now: number,
  reportError: ExpirySweepErrorReporter = reportExpirySweepError,
): number {
  let closed = 0;
  for (const conn of conns) {
    if (!isPrincipalExpired(conn.principal, now)) continue;
    try {
      conn.ws.close(4401, 'expired');
    } catch (err) {
      // A synchronous close throw means the socket was NOT closed.  Do not
      // inflate the returned count; callers use it as their expiry result.
      reportError('close', err);
      continue;
    }
    closed++;
  }
  return closed;
}

/**
 * Await + sweep every room-like value in `rooms` (a `RoomManager`'s pending
 * `Room` promises), reporting one whose load promise rejected — a poisoned
 * room is evicted elsewhere and must not abort the sweep for the rest.
 * Returns the total connections closed.
 */
export async function sweepExpiredAcrossRooms<R extends { sweepExpiredPrincipals(now: number): number }>(
  rooms: Iterable<Promise<R>>,
  now: number,
  reportError: ExpirySweepErrorReporter = reportExpirySweepError,
): Promise<number> {
  let closed = 0;
  for (const pending of rooms) {
    let room: R;
    try {
      room = await pending;
    } catch (err) {
      // A room load failure does not stop other rooms being swept, but it is
      // not a successful zero-connection result either.  Report it before
      // continuing so operators can distinguish that state from no expiry.
      reportError('room-load', err);
      continue;
    }
    closed += room.sweepExpiredPrincipals(now);
  }
  return closed;
}

/** Start the periodic sweep; `stop()` clears it (call from `stop()` in server.ts). */
export function startExpirySweep(roomManager: {
  sweepExpiredPrincipals(): Promise<number>;
}): { stop: () => void } {
  const timer = setInterval(() => {
    void roomManager.sweepExpiredPrincipals().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[collab-server] expiry sweep error:', err);
    });
  }, EXPIRY_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
