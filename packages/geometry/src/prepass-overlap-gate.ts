/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pre-pass / geometry-pool overlap gate (#10264).
 *
 * The pool's process workers grow their WASM heaps when they receive this
 * load's setup (entity index, pre-pass columns) and their first chunk (which
 * installs a full copy of the source). Normally that starts while the pre-pass
 * worker is still scanning, so its peak heap (about 1.25x the file) coexists
 * with every process worker's source copy, entity index and early meshing.
 * Measured on entity-heavy 1.2 GB files with ONE process worker, this overlap
 * is the whole tab's peak before any geometry exists (about 5.5x the file, vs
 * about 3.7x once the pre-pass worker is gone), and a 6 GiB tab is killed in it.
 *
 * For large sources the pool therefore holds every per-load setup message and
 * every jobs chunk until the pre-pass has completed and its worker has been
 * terminated, then delivers them in their original order. Each worker receives
 * exactly the message sequence it would have received without the gate, only
 * later, so geometry output is unchanged. The sharded index scan is off for
 * gated loads because it installs the source into every process worker before
 * the pre-pass even starts.
 *
 * Small and medium files keep today's path and timing: the overlap costs at
 * most about 1.25x the file there, and starting geometry before the pre-pass
 * ends is what keeps their first geometry early.
 */

/**
 * Gate threshold. 512 MiB is above every file the load-time goals measure
 * (the largest, about 343 MB, keeps the ungated path) and below the smallest
 * file the #10264 measurements saw killed before geometry (a 572 MB
 * entity-heavy file loaded under a 6 GiB cap, a 858 MB one was killed). It is
 * also where the worker planner already switches to its large-file tiers.
 */
export const PREPASS_OVERLAP_GATE_MIN_BYTES = 512 * 1024 * 1024;

/** True when a load of `sourceBytes` holds the pool until the pre-pass ends. */
export function holdsPoolUntilPrepassEnds(sourceBytes: number): boolean {
  return sourceBytes >= PREPASS_OVERLAP_GATE_MIN_BYTES;
}

type WorkerSetup = (worker: Worker) => void;

/**
 * Per-load setup log for the pool. `broadcast` records a setup (the log is
 * replayed to replacement workers) and posts it to every worker, unless the
 * broadcaster is holding, in which case the setup waits for `release`, which
 * posts all held setups in their original order. Releasing twice is a no-op.
 */
export class PoolSetupBroadcast {
  /** Every setup in order, for replay to a replacement worker. */
  readonly log: WorkerSetup[] = [];
  private held: WorkerSetup[] | null;

  constructor(private readonly workers: readonly Worker[], hold: boolean) {
    this.held = hold ? [] : null;
  }

  get holding(): boolean {
    return this.held !== null;
  }

  broadcast(setup: WorkerSetup): void {
    this.log.push(setup);
    if (this.held) {
      this.held.push(setup);
      return;
    }
    for (const worker of this.workers) setup(worker);
  }

  release(): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    for (const setup of held) {
      for (const worker of this.workers) setup(worker);
    }
  }
}
