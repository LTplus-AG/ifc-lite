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
 *
 * The window is REFILLED on expiry, not abandoned, and that is deliberate: a
 * GPU that reports nothing for this long renders about `GPU_FRAMES_IN_FLIGHT`
 * frames per expiry (about 0.6 fps at the defaults). Expiry cannot tell a dead
 * device from a slow one (a stall, a software GPU at seconds per frame), and
 * dropping pacing for the slow one lets the queue grow without bound, which is
 * the #5865 failure.
 *
 * THE REAL BOUND. The queue is bounded (about `2 * GPU_FRAMES_IN_FLIGHT` frames
 * through a stall longer than the expiry) while the GPU completes frames faster
 * than the refill admits them, about 0.6 per second: up to roughly 1.7 s per
 * frame. A GPU slower than that is outrun: a frame waiting behind two others
 * expires after 5 s while still owed, so frames are admitted at 0.6 per second
 * but complete at 1 / (seconds per frame), and the backlog grows by the
 * difference (about 0.1 frame per second at 2 s per frame: 62 queued after
 * 10 minutes, a 2 minute pick delay). A fix has to tell "no completion for
 * 5 s" from "this frame is old"; that is deliberately not done here.
 */
export const GPU_FRAME_STALE_MS = 5000;

/** The part of a GPUDevice the pacer needs. */
export interface PacedDevice { queue: { onSubmittedWorkDone(): Promise<unknown> } }

export class GpuFramePacer {
  private readonly submitted = new Map<number, number>();
  private serial = 0;
  private device: PacedDevice | null = null;
  private warned = false;

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
   * resolved and a rejected completion free the slot.
   */
  noteSubmit(device: PacedDevice | null, now: number): void {
    this.adopt(device);
    if (!device) return;
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
    const settle = () => { this.submitted.delete(id); };
    done.then(settle, settle);
  }

  /**
   * True while `maxInFlight` frames are still outstanding: do not submit
   * another. Frames owed by a different (lost, then recovered) device are
   * forgotten: nothing they were queued on will ever report back.
   */
  saturated(device: PacedDevice | null, now: number): boolean {
    this.adopt(device);
    for (const [id, at] of this.submitted) {
      if (now - at > this.staleMs) this.submitted.delete(id);
    }
    return this.submitted.size >= this.maxInFlight;
  }

  private adopt(device: PacedDevice | null): void {
    if (device === this.device) return;
    this.device = device;
    this.submitted.clear();
  }
}
