/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The surface the last frame drew under a canvas point, read from that
 * frame's own depth attachment (#8769).
 *
 * Navigation on a large model cannot afford the CPU raycast (its first call
 * builds a BVH over every entity, `orbitPivotCensus.ts`), and the GPU pick
 * re-renders every mesh into its own target. The main pass has already
 * rasterised the answer: its depth holds the nearest opaque surface per
 * texel, and only real surfaces write it (overlays and transparent geometry
 * do not). Reading one texel of it is one compute dispatch and a 4-byte
 * readback, whatever the model size.
 *
 * The texel is unprojected with the immutable RTE snapshot of the frame that
 * wrote it, never the live camera, so a readback that lands after the camera
 * moved still yields the correct world point.
 */

import { PickDepthSample } from './picker-depth-sample.js';
import { isReadbackAbort, PickerReadbackOwner } from './picker-readbacks.js';
import { restoreRtePickWorld, unprojectPickSample } from './pick-world-position.js';
import type { RelativeToEyeSnapshot } from './relative-to-eye.js';
import type { Vec3 } from './types.js';

/** What one completed frame left in the depth attachment. */
export interface FrameDepthRecord {
  snapshot: RelativeToEyeSnapshot;
  /** Depth attachment size, device px. */
  width: number;
  height: number;
  /** Canvas size the frame was laid out for, CSS px. */
  cssWidth: number;
  cssHeight: number;
}

export class FrameDepthProbe {
  private frame: FrameDepthRecord | null = null;
  private armed = false;
  private sampler: PickDepthSample | null = null;
  private readonly readbacks: PickerReadbackOwner;

  constructor(
    private readonly device: GPUDevice,
    private readonly depthTexture: () => GPUTexture,
    private readonly sampleCount: number,
  ) {
    this.readbacks = new PickerReadbackOwner(device);
  }

  /**
   * Whether the renderer should record frames. Nothing is recorded until the
   * first probe, so a session that never needs one pays nothing per frame.
   */
  get wanted(): boolean {
    return this.armed;
  }

  /** Call after each completed frame's submit. */
  frameDrawn(record: FrameDepthRecord): void {
    this.frame = record;
  }

  /**
   * World point of the nearest surface the last frame drew under the CSS-px
   * canvas point `(x, y)`, or null for empty space, an unusable frame, or a
   * device lost mid-readback. `cssWidth`/`cssHeight` is the canvas size now;
   * a layout change since the frame makes its texels stale, so it is a miss.
   */
  async probe(x: number, y: number, cssWidth: number, cssHeight: number): Promise<Vec3 | null> {
    this.armed = true;
    const frame = this.frame;
    if (!frame || this.readbacks.deviceLost) return null;
    if (Math.abs(frame.cssWidth - cssWidth) > 0.5 || Math.abs(frame.cssHeight - cssHeight) > 0.5) return null;
    if (!(x >= 0 && y >= 0 && x < frame.cssWidth && y < frame.cssHeight)) return null;
    const texture = this.depthTexture();
    // A resize replaced the attachment after this frame; its content is not the frame's.
    if (texture.width !== frame.width || texture.height !== frame.height) return null;
    const tx = Math.min(frame.width - 1, Math.floor((x * frame.width) / frame.cssWidth));
    const ty = Math.min(frame.height - 1, Math.floor((y * frame.height) / frame.cssHeight));

    this.sampler ??= new PickDepthSample(this.device, this.sampleCount);
    const staging = this.device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this.readbacks.track(staging);
    let resources: readonly GPUBuffer[] = [];
    let depth: number;
    try {
      const encoder = this.device.createCommandEncoder();
      resources = this.sampler.encode(encoder, texture, tx, ty, staging, 0);
      this.readbacks.track(...resources);
      this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      if (this.readbacks.deviceLost) return null;
      depth = new Float32Array(staging.getMappedRange(), 0, 1)[0];
    } catch (err) {
      if (!this.readbacks.deviceLost && !isReadbackAbort(err)) throw err;
      return null;
    } finally {
      this.readbacks.release(staging, ...resources);
    }
    // Reverse-Z clears to 0: nothing drawn there.
    return restoreRtePickWorld(
      unprojectPickSample(frame.snapshot.getViewProjection().m, tx, ty, frame.width, frame.height, depth),
      frame.snapshot,
    );
  }

  destroy(): void {
    this.frame = null;
    this.readbacks.destroy();
  }
}
