/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bounds how many submitted frames the GPU may still owe the page (#5865).
 *
 * `GPUQueue.submit` returns at once, and the render loop's cost estimate
 * (`renderer.render()` wall time) only sees the CPU side of a frame, so on a GPU
 * that is slower than the loop (software WebGPU, a busy integrated GPU) frames
 * pile up in the queue without bound. Everything later on that queue waits
 * behind them: the ID-buffer pick's `mapAsync` took 3-4 s on the first tap after
 * a pinch while the page itself was idle, because ~35 frames of orbit and inertia
 * were still ahead of it. Holding the loop back once a few frames are
 * outstanding keeps the dirty flag and camera state current, so the next frame
 * that is allowed carries the newest view, and a pick waits for at most the
 * allowed depth.
 */
export const GPU_FRAMES_IN_FLIGHT = 3;

/**
 * A frame whose completion was never reported (a lost device may settle
 * nothing) must not stop rendering for good, so an entry older than this no
 * longer counts. Far above any frame a working GPU takes.
 */
export const GPU_FRAME_STALE_MS = 5000;

export class GpuFramePacer {
  private readonly submitted = new Map<number, number>();
  private serial = 0;

  constructor(
    private readonly maxInFlight = GPU_FRAMES_IN_FLIGHT,
    private readonly staleMs = GPU_FRAME_STALE_MS,
  ) {}

  /** Record a frame just submitted; `done` settles when the GPU has finished it. */
  noteSubmit(done: Promise<unknown>, now: number): void {
    const id = this.serial++;
    this.submitted.set(id, now);
    const settle = () => { this.submitted.delete(id); };
    done.then(settle, settle);
  }

  /** True while `maxInFlight` frames are still outstanding: do not submit another. */
  saturated(now: number): boolean {
    for (const [id, at] of this.submitted) {
      if (now - at > this.staleMs) this.submitted.delete(id);
    }
    return this.submitted.size >= this.maxInFlight;
  }
}
