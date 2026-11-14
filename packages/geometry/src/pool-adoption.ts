/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SPIKE (streaming scan, flag `?streamScan=`): a geometry pool started at the
 * pick, before the file is read, handed to the load's `processParallel`.
 *
 * - `workers`: geometry workers spawned at the pick (mode a and ab). The pool
 *   adopts them instead of spawning its own and sends them its usual `init`.
 * - `shards`: entity-index shards scanned while the file was still arriving
 *   (mode ab). When present the pool skips its own shard dispatch and stitches
 *   these. Null means "scan as usual".
 *
 * Keyed by the source SAB (mode ab) or, when the SAB is made after the read
 * (mode a), by the source length.
 */
import type { ShardColumns } from './shard-stitch.js';

export interface PoolAdoption {
  sab: SharedArrayBuffer | null;
  byteLength: number;
  workers: Worker[];
  shards: Promise<ShardColumns[] | null> | null;
}

let pending: PoolAdoption | null = null;

export function offerPoolAdoption(adoption: PoolAdoption): void {
  if (pending && pending !== adoption) for (const w of pending.workers) w.terminate();
  pending = adoption;
}

/** Take the offered pool if it was offered for exactly this source buffer. */
export function takePoolAdoption(sab: SharedArrayBuffer): PoolAdoption | null {
  if (!pending) return null;
  if (pending.sab ? pending.sab !== sab : pending.byteLength !== sab.byteLength) return null;
  const taken = pending;
  pending = null;
  return taken;
}

/** Drop an offer nobody took (cache hit, error, superseded load). */
export function withdrawPoolAdoption(adoption: PoolAdoption): void {
  if (pending !== adoption) return;
  pending = null;
  for (const w of adoption.workers) w.terminate();
}
