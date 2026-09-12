/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The owner seed's `confirmRelay` (#4446): poll the relay's state vector
 * until it covers the owner's, so `'ready'` means "the server holds the
 * model", not "the browser has queued it". Without a relay (local-only
 * IndexedDB session) there is nothing to confirm.
 *
 * Each probe is a throw-away websocket that reads the server's sync-step-1
 * frame and closes (`fetchRoomStateVector`); peers never see it. Probes stop
 * as soon as the join is abandoned. A relay that stays behind for the whole
 * budget is reported as unconfirmed — the caller turns that into a failed
 * seed rather than a link to a room that may be empty.
 */

export type RelayProbe = Pick<typeof import('@ifc-lite/collab'), 'fetchRoomStateVector' | 'stateVectorCovers'>;

export interface ConfirmRelayOptions {
  /** Total budget before giving up (default 30 s). */
  timeoutMs?: number;
  /** Pause between probes (default 250 ms). */
  intervalMs?: number;
  /** Per-probe handshake timeout (default 5 s). */
  probeTimeoutMs?: number;
}

export async function confirmRelayHoldsState(
  collab: RelayProbe,
  serverUrl: string | null,
  roomId: string,
  token: string | undefined,
  stateVector: Uint8Array,
  isCurrent: () => boolean,
  options: ConfirmRelayOptions = {},
): Promise<boolean> {
  if (!serverUrl) return true;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let lastError: unknown = null;
  while (isCurrent() && Date.now() < deadline) {
    try {
      const held = await collab.fetchRoomStateVector(serverUrl, roomId, {
        token,
        timeoutMs: options.probeTimeoutMs ?? 5_000,
      });
      if (collab.stateVectorCovers(stateVector, held)) return true;
    } catch (err) {
      // A probe that cannot reach the relay is the same answer as "not yet":
      // keep asking until the budget runs out, then report unconfirmed.
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 250));
  }
  if (isCurrent() && lastError) {
    // eslint-disable-next-line no-console
    console.warn('[collab] relay confirmation probe kept failing:', lastError);
  }
  return false;
}
