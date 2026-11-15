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
 * with the process worker's source copy, entity index and early meshing.
 * Measured on an entity-heavy 1.2 GB synthetic with ONE process worker, that
 * overlap is the tab's peak before any geometry exists (about 6.9 GB summed
 * PSS), and a 6 GiB tab is killed in it.
 *
 * For a large source planned with exactly one process worker, the pool
 * therefore holds every per-load setup message and every jobs chunk until the
 * pre-pass has completed and its worker has been terminated, then delivers
 * them in their original order. The worker receives exactly the message
 * sequence it would have received without the gate, only later, so geometry
 * output is unchanged (measured: about 1.4 GB lower pre-geometry peak).
 *
 * Loads planned with two or more workers keep main's path unchanged,
 * including the sharded index scan. There the pool's own source copies
 * dominate (measured with four workers: about 0.7 GB saved) while holding
 * would move first geometry from about 6 s to about 18 s, because the sharded
 * scan is what gives such a pool its index early. Small and medium files keep
 * today's path at any worker count.
 */

/**
 * Size threshold. 512 MiB is above every file the load-time goals measure
 * (the largest, about 343 MB, keeps the ungated path) and below the smallest
 * file the #10264 measurements saw killed before geometry (a 572 MB
 * entity-heavy file loaded under a 6 GiB cap, a 858 MB one was killed).
 */
export const PREPASS_OVERLAP_GATE_MIN_BYTES = 512 * 1024 * 1024;

/**
 * True when a load of `sourceBytes` whose pool was planned with
 * `plannedWorkers` process workers (the count the pool is built with,
 * including an explicit `?geomWorkers` override) holds the pool until the
 * pre-pass ends.
 */
export function holdsPoolUntilPrepassEnds(sourceBytes: number, plannedWorkers: number): boolean {
  return sourceBytes >= PREPASS_OVERLAP_GATE_MIN_BYTES && plannedWorkers === 1;
}

type WorkerSetup = (worker: Worker) => void;

/**
 * Per-load setup log for the pool. `broadcast` records a setup (the log is
 * replayed to replacement workers) and posts it to every worker, unless the
 * broadcaster is holding, in which case the setup waits for `release`, which
 * posts all held setups in their original order. Releasing twice is a no-op.
 * `replayTo` brings a replacement worker up to date with the RELEASED setups
 * only: a replacement that joins the pool while it holds receives the held
 * ones from `release`, like every other worker, and so never receives any
 * setup twice.
 */
export class PoolSetupBroadcast {
  private readonly log: WorkerSetup[] = [];
  private held: WorkerSetup[] | null;

  constructor(private readonly workers: readonly Worker[], hold: boolean) {
    this.held = hold ? [] : null;
  }

  get holding(): boolean {
    return this.held !== null;
  }

  /** Record a setup the caller posts itself (worker init), for replay only. */
  record(setup: WorkerSetup): void {
    this.log.push(setup);
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

  /** Post every released setup, in order, to one (replacement) worker. */
  replayTo(worker: Worker): void {
    const released = this.log.length - (this.held?.length ?? 0);
    for (let i = 0; i < released; i++) this.log[i](worker);
  }

  /** Drop the replay log (no replacement can need it any more). */
  clear(): void {
    this.log.length = 0;
  }
}
