/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Single-flight, generation-checked init for `IfcLiteBridge`.
 *
 * A `boolean` plus a nullable handle could not tell "in flight" from "not
 * started", nor notice a `dispose()` that landed mid-init: overlapping
 * `init()` calls each built an engine handle (the first leaked), and init
 * resumed after `dispose()` to mark the bridge initialized again.
 *
 * - Concurrent `run()` calls join one in-flight attempt.
 * - A failed attempt is forgotten, so a later `run()` retries.
 * - `invalidate()` (dispose) bumps the generation: an attempt started under an
 *   older generation must build nothing (`isCurrent`) and rejects as
 *   superseded; the next `run()` starts afresh. Dispose is not terminal.
 *
 * Bridge-local on purpose; a shared lifetime primitive can replace it without
 * touching the bridge's call sites.
 */

/** Rejection for an `init()` that a `dispose()` overtook. */
export function initSupersededError(): Error {
  return new Error('IfcLiteBridge.init() was superseded by dispose() before it finished');
}

export class BridgeInitGate {
  private generation = 0;
  private inFlight: Promise<void> | null = null;
  private ready = false;

  isReady(): boolean {
    return this.ready;
  }

  /** False once a `dispose()` has overtaken the attempt started at `generation`. */
  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  run(start: (generation: number) => Promise<void>): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const attempt = start(generation).then(() => {
      if (!this.isCurrent(generation)) throw initSupersededError();
      this.ready = true;
    }).finally(() => {
      // A stale attempt settling late must not drop a newer one.
      if (this.inFlight === attempt) this.inFlight = null;
    });
    this.inFlight = attempt;
    return attempt;
  }

  /** The handle was dropped (dispose, reset or trap recovery). */
  release(): void {
    this.ready = false;
  }

  /** Overtake any in-flight attempt; the next `run()` starts a fresh one. */
  invalidate(): void {
    this.generation += 1;
    this.inFlight = null;
  }
}
