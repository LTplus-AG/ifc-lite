/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RenderPipeline } from './pipeline.js';
import type { Mesh } from './types.js';

/** Give an individual mesh its own uniform buffer and group(0) bind group, once. */
export function ensureMeshUniform(
  device: GPUDevice,
  pipeline: Pick<RenderPipeline, 'getUniformBufferSize' | 'getBindGroupLayout'>,
  mesh: Pick<Mesh, 'uniformBuffer' | 'bindGroup'>,
): void {
  if (mesh.uniformBuffer) return;
  mesh.uniformBuffer = device.createBuffer({
    size: pipeline.getUniformBufferSize(),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  mesh.bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(),
    entries: [{ binding: 0, resource: { buffer: mesh.uniformBuffer } }],
  });
}
