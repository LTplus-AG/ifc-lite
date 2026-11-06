/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { releaseReadbacks } from './picker-readbacks.js';

/**
 * Internal single-texel depth extraction: GPU point picking, and the frame
 * depth probe (`frame-depth-probe.ts`), which reads the multisampled main
 * depth. A multisampled texel reports its nearest sample (reverse-Z: the
 * largest), so an edge texel never reads deeper than the surface it touches.
 */
export class PickDepthSample {
  private readonly pipeline: GPUComputePipeline;

  constructor(private readonly device: GPUDevice, sampleCount = 1) {
    const load = sampleCount > 1
      ? `var d = 0.0;
            for (var s = 0i; s < ${sampleCount}i; s++) { d = max(d, textureLoad(depth, vec2<i32>(texel), s)); }
            result = d;`
      : 'result = textureLoad(depth, vec2<i32>(texel), 0);';
    this.pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: `
          @group(0) @binding(0) var depth: ${sampleCount > 1 ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
          @group(0) @binding(1) var<uniform> texel: vec2<u32>;
          @group(0) @binding(2) var<storage, read_write> result: f32;
          @compute @workgroup_size(1)
          fn main() {
            ${load}
          }
        ` }),
        entryPoint: 'main',
      },
    });
  }

  /** Append to the render encoder; the caller frees the returned per-pick buffers. */
  encode(
    encoder: GPUCommandEncoder,
    depthTexture: GPUTexture,
    x: number,
    y: number,
    staging: GPUBuffer,
    offset: number,
  ): readonly GPUBuffer[] {
    // Immutable mapped-at-creation coordinates avoid queue writes racing another
    // pick. Fresh storage/staging also permits overlapping asynchronous maps.
    const coordinates = this.device.createBuffer({
      size: 8, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true,
    });
    let result: GPUBuffer | undefined;
    try {
      new Uint32Array(coordinates.getMappedRange()).set([x, y]);
      coordinates.unmap();
      result = this.device.createBuffer({
        size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      const bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: depthTexture.createView({ aspect: 'depth-only' }) },
          { binding: 1, resource: { buffer: coordinates } },
          { binding: 2, resource: { buffer: result } },
        ],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(result, 0, staging, offset, 4);
      return [coordinates, result];
    } catch (err) {
      releaseReadbacks(coordinates, ...(result ? [result] : []));
      throw err;
    }
  }
}
