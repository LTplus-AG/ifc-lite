/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Network-latency simulation (spec §15 §18).
 *
 * Helpers for benchmarking how a CRDT pipeline behaves under delay,
 * jitter, packet loss, or partition. The simulator wraps a pair of
 * Y.Docs with a queued, time-bucketed update channel — call
 * `flushUntil(t)` to advance time and dispatch any updates whose
 * delivery time has arrived.
 *
 * This is benchmark-only: production sync goes through providers.
 */

import * as Y from 'yjs';

export interface LatencyParams {
  /** Mean one-way latency in ms (default 50). */
  baseMs?: number;
  /** Random jitter ±jitterMs added to each delivery (default 0). */
  jitterMs?: number;
  /** Probability [0..1] that a delivery is dropped (default 0). */
  dropRate?: number;
  /** Override the random source (default Math.random). */
  random?: () => number;
}

interface Pending {
  toClient: 'a' | 'b';
  arrivesAt: number;
  payload: Uint8Array;
}

export interface LatencyChannel {
  /** Inject the docs' initial state vectors into each other. */
  initialSync(): void;
  /** Advance simulated time and deliver any updates due at-or-before `t`. */
  flushUntil(t: number): void;
  /** Total updates that have been delivered. */
  delivered(): number;
  /** Total updates that were dropped. */
  dropped(): number;
}

/**
 * Build a one-way-symmetric latency channel between `a` and `b`. Both
 * docs subscribe to each other's `update` events; outbound updates are
 * queued with simulated arrival time and dispatched on `flushUntil`.
 */
export function createLatencyChannel(
  a: Y.Doc,
  b: Y.Doc,
  params: LatencyParams = {},
): LatencyChannel {
  const baseMs = params.baseMs ?? 50;
  const jitterMs = params.jitterMs ?? 0;
  const dropRate = params.dropRate ?? 0;
  const rand = params.random ?? Math.random;

  let now = 0;
  let delivered = 0;
  let dropped = 0;
  const queue: Pending[] = [];

  const arrivalTime = () => {
    const jitter = jitterMs > 0 ? (rand() * 2 - 1) * jitterMs : 0;
    return now + baseMs + jitter;
  };

  const onA = (update: Uint8Array, origin: unknown) => {
    if (origin === 'sim') return;
    if (rand() < dropRate) {
      dropped += 1;
      return;
    }
    queue.push({ toClient: 'b', arrivesAt: arrivalTime(), payload: update });
  };
  const onB = (update: Uint8Array, origin: unknown) => {
    if (origin === 'sim') return;
    if (rand() < dropRate) {
      dropped += 1;
      return;
    }
    queue.push({ toClient: 'a', arrivesAt: arrivalTime(), payload: update });
  };
  a.on('update', onA);
  b.on('update', onB);

  return {
    initialSync() {
      const aSv = Y.encodeStateVector(a);
      const bSv = Y.encodeStateVector(b);
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a, bSv), 'sim');
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b, aSv), 'sim');
    },
    flushUntil(t) {
      now = t;
      // Deliver in time order. We sort once per call rather than
      // maintaining a heap — tests typically have a few hundred entries.
      queue.sort((x, y) => x.arrivesAt - y.arrivesAt);
      while (queue.length > 0 && queue[0].arrivesAt <= now) {
        const item = queue.shift()!;
        if (item.toClient === 'a') Y.applyUpdate(a, item.payload, 'sim');
        else Y.applyUpdate(b, item.payload, 'sim');
        delivered += 1;
      }
    },
    delivered: () => delivered,
    dropped: () => dropped,
  };
}
