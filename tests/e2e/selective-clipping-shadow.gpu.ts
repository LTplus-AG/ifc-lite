/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ShadowPass, type ShadowClip } from '../../packages/renderer/src/shadow-pass.js';
import { collectShadowOccluders } from '../../packages/renderer/src/shadow-occluders.js';
import type { Scene } from '../../packages/renderer/src/scene.js';

/** Read actual shadow-map texels at the same six analytical sample points (#8015). */
export function shadowProbe(device: GPUDevice, scene: Pick<Scene, 'getBatchedMeshes' | 'getInstancedTemplates' | 'getTexturedMeshes' | 'getMeshes'>) {
  const shadow = new ShadowPass(device, 256);
  const result = device.createBuffer({ size: 24, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 24, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const module = device.createShaderModule({ code: `
    @group(0) @binding(0) var depth: texture_depth_2d;
    @group(0) @binding(1) var<storage, read_write> result: array<f32>;
    @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let ys = array<i32, 3>(192, 149, 85);
      let x = select(64, 192, gid.x >= 3u);
      result[gid.x] = textureLoad(depth, vec2<i32>(x, ys[gid.x % 3u]), 0);
    }` });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const binding = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: shadow.getDepthTextureView() }, { binding: 1, resource: { buffer: result } },
  ] });
  return {
    async read(cx: number, clip: ShadowClip): Promise<boolean[]> {
      const draws = collectShadowOccluders({ batches: scene.getBatchedMeshes(), instanced: scene.getInstancedTemplates(),
        textured: scene.getTexturedMeshes(), meshes: scene.getMeshes() });
      // x in [-12,+12], y in [-6,+6], constant reverse-Z depth 0.5.
      const matrix = { m: new Float32Array([1 / 12, 0, 0, 0, 0, 1 / 6, 0, 0, 0, 0, 0, 0, -cx / 12, 0, 0.5, 1]) };
      const encoder = device.createCommandEncoder();
      shadow.render(encoder, matrix, draws, clip);
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, binding); pass.dispatchWorkgroups(6); pass.end();
      encoder.copyBufferToBuffer(result, 0, readback, 0, 24);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      try { return Array.from(new Float32Array(readback.getMappedRange()), depth => depth > 0); }
      finally { readback.unmap(); }
    },
    destroy() { shadow.destroy(); result.destroy(); readback.destroy(); },
  };
}
