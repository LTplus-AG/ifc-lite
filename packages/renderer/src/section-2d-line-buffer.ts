/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One world-space line-list vertex buffer.
 *
 * `Section2DOverlayRenderer` backs five standalone line overlays (annotation
 * #653, alignment, grid #967, DXF #2043, clash box #1277) that are byte-for-byte
 * identical apart from which buffer they read and which colour they draw in.
 * This is the ONLY thing those families genuinely own on their own: a vertex
 * buffer and its vertex count.
 *
 * Deliberately NOT an owner of anything shared. The line pipeline, the
 * bind-group layout, the bind group and the 160-byte uniform buffer stay owned
 * solely by `Section2DOverlayRenderer` and are handed in per draw as
 * {@link SectionLinePipelineResources}. That keeps the renderer's single
 * `init()`/`dispose()` lifecycle the one place those resources are created and
 * destroyed — giving each family its own pipeline handle is the split that
 * would put one GPU object under six owners (issue #2456).
 */

import {
  SECTION_2D_UNIFORM_FLOATS,
  SECTION_2D_UNIFORM_SLOTS,
} from './shaders/section-2d-overlay.wgsl.js';

/** Shared GPU resources a {@link WorldLineBuffer} borrows for the duration of a draw. */
export interface SectionLinePipelineResources {
  device: GPUDevice;
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  uniformBuffer: GPUBuffer;
  /** Byte stride between the uniform slots in `uniformBuffer`. */
  uniformStride: number;
}

/** Minimum floats for one line segment: two 3-float vertices. */
const FLOATS_PER_SEGMENT = 6;

export class WorldLineBuffer {
  private buffer: GPUBuffer | null = null;
  private count = 0;

  /**
   * @param uniformSlot Index of this family's record in the shared uniform
   *   buffer. Every family needs its own: the six overlay draws are encoded
   *   into one pass and `queue.writeBuffer` lands before the pass runs, so a
   *   shared record means the last family's colour is the one all six get.
   *   See `SECTION_2D_UNIFORM_SLOT_INDEX`.
   */
  constructor(private readonly uniformSlot: number) {}

  /**
   * Replace the buffer's contents with a flat `[x,y,z, x,y,z, …]` line-list in
   * world space. Anything shorter than one full segment clears instead, which
   * is how every caller passes "no lines".
   *
   * Only **whole** segments are uploaded. The vertex count went straight to
   * `pass.draw()` as `vertices.length / 3`, so a length that was not a multiple
   * of 3 produced a *fractional* vertex count — a WebGPU validation error that
   * kills the whole command buffer, taking every other overlay in the pass down
   * with it — and an odd whole vertex count left a dangling half-segment the
   * line-list topology would discard anyway. Both are reachable: these arrays
   * are assembled by upstream polyline/arc flatteners, not written by hand.
   *
   * Truncating rather than rejecting the whole array is deliberate. One stray
   * float from a flattener should cost the caller the incomplete tail segment,
   * not the entire grid / DXF / annotation layer.
   */
  upload(device: GPUDevice, vertices: Float32Array): void {
    this.clear();
    const usableFloats = Math.floor(vertices.length / FLOATS_PER_SEGMENT) * FLOATS_PER_SEGMENT;
    if (usableFloats === 0) return;

    const data = usableFloats === vertices.length ? vertices : vertices.subarray(0, usableFloats);
    this.buffer = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.buffer, 0, data);
    this.count = usableFloats / 3;
  }

  /** Destroy the buffer and reset the count. Safe to call repeatedly. */
  clear(): void {
    if (this.buffer) {
      this.buffer.destroy();
      this.buffer = null;
    }
    this.count = 0;
  }

  has(): boolean {
    return this.count > 0;
  }

  /** Vertex count, for tests and for the caller's own bookkeeping. */
  get vertexCount(): number {
    return this.count;
  }

  /**
   * Draw the buffer in `color`. `planeOffset` is left zeroed — these vertices
   * are already in world space, so unlike the section-cut outline they do not
   * ride the section plane.
   *
   * Writes into — and binds — **this family's own** uniform slot. Sharing one
   * record across the pass's six draws meant the last write before submit was
   * what every draw read.
   *
   * No-ops when the buffer is empty, so callers do not need their own guard.
   */
  draw(
    pass: GPURenderPassEncoder,
    resources: SectionLinePipelineResources,
    viewProj: Float32Array,
    color: readonly [number, number, number, number],
  ): void {
    if (!this.buffer || this.count === 0) return;

    const byteOffset = this.uniformSlot * resources.uniformStride;
    const uniforms = new Float32Array(SECTION_2D_UNIFORM_FLOATS);
    uniforms.set(viewProj, SECTION_2D_UNIFORM_SLOTS.viewProj);
    // planeOffset stays 0 — vertices are already in world space.
    uniforms.set(color, SECTION_2D_UNIFORM_SLOTS.lineColor);
    resources.device.queue.writeBuffer(resources.uniformBuffer, byteOffset, uniforms);

    pass.setPipeline(resources.pipeline);
    pass.setBindGroup(0, resources.bindGroup, [byteOffset]);
    pass.setVertexBuffer(0, this.buffer);
    pass.draw(this.count);
  }
}
