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
 * frame and closes (`fetchRoomStateVector`); peers never see it. The first
 * probe is immediate (over loopback the whole confirmation is ~10 ms); the
 * pause between probes then backs off 250 → 500 → 1000 ms, because every
 * probe is an authenticated connection the relay audits. Probes stop as soon
 * as the join is abandoned.
 *
 * Two budgets, both reported as "unconfirmed" — the caller turns that into a
 * failed seed rather than a link to a room that may be empty:
 *   - `unreachableMs` (30 s) counts only while probes FAIL. A relay that
 *     answers but is still behind is a relay the bytes are in transit to
 *     (a large doc on a slow uplink, structure queued behind blob PUTs),
 *     and the honest state for that is `confirming`, not `failed`.
 *   - `maxWaitMs` (10 min) caps a reachable relay that never catches up,
 *     which no healthy y-websocket session produces — it is the guard that
 *     keeps a broken provider from pinning the dialog on "Confirming…" forever.
 */

export type RelayProbe = Pick<typeof import('@ifc-lite/collab'), 'fetchRoomStateVector' | 'stateVectorCovers'>;

export interface ConfirmRelayInput {
  collab: RelayProbe;
  /** `null` for a local-only session: nothing to confirm. */
  serverUrl: string | null;
  roomId: string;
  /** The room token the live provider uses (the probe authenticates the same way). */
  token: string | undefined;
  /** `Y.encodeStateVector(doc)` after the seed's last local write. */
  stateVector: Uint8Array;
  /** False once this join was abandoned (a newer start/stop ran); stops probing. */
  isCurrent: () => boolean;
  /** Give up after this long WITHOUT a successful probe (default 30 s). */
  unreachableMs?: number;
  /** Absolute cap on the whole confirmation (default 10 min). */
  maxWaitMs?: number;
  /** First pause between probes (default 250 ms); doubles up to `maxIntervalMs`. */
  intervalMs?: number;
  /** Longest pause between probes (default 1 s). */
  maxIntervalMs?: number;
  /** Per-probe handshake timeout (default 5 s). */
  probeTimeoutMs?: number;
}

export async function confirmRelayHoldsState(input: ConfirmRelayInput): Promise<boolean> {
  const { collab, serverUrl, roomId, token, stateVector, isCurrent } = input;
  if (!serverUrl) return true;
  const unreachableMs = input.unreachableMs ?? 30_000;
  const maxInterval = input.maxIntervalMs ?? 1_000;
  const start = Date.now();
  const hardDeadline = start + (input.maxWaitMs ?? 600_000);
  let unreachableSince: number | null = null;
  let lastError: unknown = null;
  let interval = input.intervalMs ?? 250;
  while (isCurrent() && Date.now() < hardDeadline) {
    try {
      const held = await collab.fetchRoomStateVector(serverUrl, roomId, {
        token,
        timeoutMs: input.probeTimeoutMs ?? 5_000,
      });
      unreachableSince = null;
      if (collab.stateVectorCovers(stateVector, held)) return true;
    } catch (err) {
      // A probe that cannot reach the relay is the same answer as "not yet"
      // until the relay has been out of reach for the whole budget.
      lastError = err;
      unreachableSince ??= Date.now();
      if (Date.now() - unreachableSince >= unreachableMs) break;
    }
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(interval * 2, maxInterval);
  }
  if (isCurrent() && lastError) {
    // eslint-disable-next-line no-console
    console.warn('[collab] relay confirmation probe kept failing:', lastError);
  }
  return false;
}
