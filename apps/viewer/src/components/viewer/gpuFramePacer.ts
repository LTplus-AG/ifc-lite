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
 * nothing) must not stop rendering for good. Once an entry is older than this
 * the pacer stops trusting completions and RELEASES the loop (no pacing at all)
 * until a completion is seen again, rather than refilling the window and
 * holding the loop to `maxInFlight` frames per expiry (about 0.6 fps at the
 * defaults). Far above any frame a working GPU takes.
 */
export const GPU_FRAME_STALE_MS = 5000;

/** The part of a GPUDevice the pacer needs. */
export interface PacedDevice { queue: { onSubmittedWorkDone(): Promise<unknown> } }

export class GpuFramePacer {
  private readonly submitted = new Map<number, number>();
  private serial = 0;
  private device: PacedDevice | null = null;
  private warned = false;
  /** Completions stopped being reported: not paced until the probe frame settles. */
  private released = false;

  constructor(
    private readonly maxInFlight = GPU_FRAMES_IN_FLIGHT,
    private readonly staleMs = GPU_FRAME_STALE_MS,
  ) {}

  /**
   * Record a frame just submitted on `device`, asking its queue to report the
   * completion. That call can throw on a device that died after the frame was
   * encoded, and that must never escape into the render loop: a throw there
   * skips the tail `requestAnimationFrame` and the viewer freezes (#2229). A
   * frame whose completion cannot be asked for is simply not counted. Both a
   * resolved and a rejected completion free the slot. While released, only one
   * probe frame is tracked at a time, so a device that never reports back holds
   * at most one pending completion per expiry instead of one per frame.
   */
  noteSubmit(device: PacedDevice | null, now: number): void {
    this.adopt(device);
    if (!device) return;
    if (this.released && this.submitted.size > 0) return;
    let done: Promise<unknown>;
    try {
      done = device.queue.onSubmittedWorkDone();
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn('[GpuFramePacer] queue.onSubmittedWorkDone() threw; this frame is not paced:', error);
      }
      return;
    }
    const id = this.serial++;
    this.submitted.set(id, now);
    const settle = () => {
      this.submitted.delete(id);
      // The GPU reports again, so pacing is meaningful again. A frame from before a
      // device switch settling late must not re-arm the new device's pacing.
      if (this.device === device) this.released = false;
    };
    done.then(settle, settle);
  }

  /**
   * True while `maxInFlight` frames are still outstanding: do not submit
   * another. Frames owed by a different (lost, then recovered) device are
   * forgotten: nothing they were queued on will ever report back. A frame older
   * than `staleMs` means completions cannot be relied on: it is forgotten and the
   * loop is released (never saturated) until a completion settles again.
   */
  saturated(device: PacedDevice | null, now: number): boolean {
    this.adopt(device);
    for (const [id, at] of this.submitted) {
      if (now - at > this.staleMs) {
        this.submitted.delete(id);
        this.released = true;
      }
    }
    return !this.released && this.submitted.size >= this.maxInFlight;
  }

  private adopt(device: PacedDevice | null): void {
    if (device === this.device) return;
    this.device = device;
    this.submitted.clear();
    this.released = false;
  }
}
