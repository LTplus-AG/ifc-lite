/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// An unlit host mesh pass for the interoperability experiment, not a replacement
// for IFC-Lite's production material/selection/appearance pipeline.
export function nativeMeshes(device, meshes) {
  const uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const shader = device.createShaderModule({ code: `
    @group(0) @binding(0) var<uniform> vp: mat4x4<f32>;
    struct V { @builtin(position) p: vec4f, @location(0) c: vec4f };
    @vertex fn vs(@location(0) p: vec3f, @location(1) c: vec4f) -> V {
      var o: V; o.p = vp * vec4f(p, 1); o.c = c; return o;
    }
    struct F { @location(0) c: vec4f, @location(1) id: vec4f };
    @fragment fn fs(v: V) -> F { var o: F; o.c = v.c; o.id = vec4f(0); return o; }
  ` });
  const pipeline = device.createRenderPipeline({ layout: 'auto',
    vertex: { module: shader, entryPoint: 'vs', buffers: [{ arrayStride: 28, attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x4' },
    ] }] }, fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }, { format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth24plus-stencil8', depthCompare: 'greater', depthWriteEnabled: true },
  });
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
  const buffers = [];
  for (const mesh of meshes) {
    const data = new Float32Array(mesh.positions.length / 3 * 7);
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      data.set(mesh.positions.subarray(i * 3, i * 3 + 3), i * 7);
      data.set([mesh.color[0], mesh.color[1], mesh.color[2], 1], i * 7 + 3);
    }
    const vertex = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const index = device.createBuffer({ size: mesh.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vertex, 0, data); device.queue.writeBuffer(index, 0, mesh.indices);
    buffers.push({ vertex, index, count: mesh.indices.length });
  }
  return {
    draw(pass, vp) {
      device.queue.writeBuffer(uniform, 0, vp);
      pass.setPipeline(pipeline); pass.setBindGroup(0, group);
      for (const item of buffers) { pass.setVertexBuffer(0, item.vertex); pass.setIndexBuffer(item.index, 'uint32'); pass.drawIndexed(item.count); }
    },
    destroy() { uniform.destroy(); for (const item of buffers) { item.vertex.destroy(); item.index.destroy(); } },
  };
}
