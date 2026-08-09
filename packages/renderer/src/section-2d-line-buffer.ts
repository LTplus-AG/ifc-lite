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
}

/** Minimum floats for one line segment: two 3-float vertices. */
const FLOATS_PER_SEGMENT = 6;

export class WorldLineBuffer {
  private buffer: GPUBuffer | null = null;
  private count = 0;

  /**
   * Replace the buffer's contents with a flat `[x,y,z, x,y,z, …]` line-list in
   * world space. Anything shorter than one full segment clears instead, which
   * is how every caller passes "no lines".
   */
  upload(device: GPUDevice, vertices: Float32Array): void {
    this.clear();
    if (vertices.length < FLOATS_PER_SEGMENT) return;

    this.buffer = device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.buffer, 0, vertices);
    this.count = vertices.length / 3;
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
   * No-ops when the buffer is empty, so callers do not need their own guard.
   */
  draw(
    pass: GPURenderPassEncoder,
    resources: SectionLinePipelineResources,
    viewProj: Float32Array,
    color: readonly [number, number, number, number],
  ): void {
    if (!this.buffer || this.count === 0) return;

    const uniforms = new Float32Array(SECTION_2D_UNIFORM_FLOATS);
    uniforms.set(viewProj, SECTION_2D_UNIFORM_SLOTS.viewProj);
    // planeOffset stays 0 — vertices are already in world space.
    uniforms.set(color, SECTION_2D_UNIFORM_SLOTS.lineColor);
    resources.device.queue.writeBuffer(resources.uniformBuffer, 0, uniforms);

    pass.setPipeline(resources.pipeline);
    pass.setBindGroup(0, resources.bindGroup);
    pass.setVertexBuffer(0, this.buffer);
    pass.draw(this.count);
  }
}
