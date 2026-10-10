/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { releaseReadbacks } from './picker-readbacks.js';

/** Internal single-texel depth extraction for GPU point picking. */
export class PickDepthSample {
  private readonly pipeline: GPUComputePipeline;

  constructor(private readonly device: GPUDevice) {
    this.pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: `
          @group(0) @binding(0) var depth: texture_depth_2d;
          @group(0) @binding(1) var<uniform> texel: vec2<u32>;
          @group(0) @binding(2) var<storage, read_write> result: f32;
          @compute @workgroup_size(1)
          fn main() {
            result = textureLoad(depth, vec2<i32>(texel), 0);
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
