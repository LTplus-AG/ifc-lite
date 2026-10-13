/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Transfer one fill partition only after every resource and its owner registration succeed. */
export function uploadFillPartition(
  device: GPUDevice, layout: GPUBindGroupLayout, data: Float32Array,
  register: (vertex: GPUBuffer, uniform: GPUBuffer, group: GPUBindGroup) => void,
): void {
  const vertex = device.createBuffer({
    label: 'symbolic-fill-vbuf', size: data.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  let uniform: GPUBuffer | undefined;
  try {
    device.queue.writeBuffer(vertex, 0, data);
    uniform = device.createBuffer({
      label: 'symbolic-fill-partition-camera', size: 160,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const group = device.createBindGroup({
      label: 'symbolic-fill-partition-bg', layout,
      entries: [{ binding: 0, resource: { buffer: uniform } }],
    });
    register(vertex, uniform, group);
  } catch (error) {
    vertex.destroy();
    uniform?.destroy();
    throw error;
  }
}
