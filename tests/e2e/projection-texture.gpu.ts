/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { RenderPipeline } from '../../packages/renderer/src/pipeline.js';
import type { WebGPUDevice } from '../../packages/renderer/src/device.js';
import { MathUtils } from '../../packages/renderer/src/math.js';
import { MESH_UNIFORM_FLOATS, MESH_UNIFORM_OFFSET } from '../../packages/renderer/src/mesh-rte-uniforms.js';
import { packEntityLane, colorSaltByte } from '../../packages/renderer/src/scene-geometry.js';
import { takeOpaqueVisibilityCommands } from '../../packages/renderer/src/opaque-visibility-commands.js';

/** Real textured fragment eligibility and partial index submissions (#6729). */
export async function runTextureDepthWitness() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const pipeline = new RenderPipeline({ getDevice: () => device, getFormat: () => 'rgba8unorm' } as WebGPUDevice, 64, 64);
  const resources: (GPUBuffer | GPUTexture)[] = [];
  const buffer = (data: ArrayBufferView, usage: GPUBufferUsageFlags) => {
    const b = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength); resources.push(b); return b;
  };
  const colour = [0.8, 0.2, 0.1, 1];
  const idForRank = (rank: number) => {
    for (let id = 1; id <= 256; id++) {
      if ((Math.imul(id ^ Math.imul(colorSaltByte(colour), 2654435761), 2654435761) & 255) === rank) return id;
    }
    throw new Error('No requested hash rank');
  };
  const frontId = idForRank(0), rearId = idForRank(255);
  const view = MathUtils.orthographicReverseZ(-1, 1, -1, 1, -500, 500);
  const sampler = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' });
  const index = buffer(new Uint32Array([0, 0, 0, 0, 1, 2, 2, 1, 3]), GPUBufferUsage.INDEX);
  const pieces = [frontId, rearId].map((id, i) => {
    const vertices = new Float32Array(36), lanes = new Uint32Array(vertices.buffer);
    for (let v = 0; v < 4; v++) {
      vertices.set([v % 2 ? 1 : -1, v >= 2 ? 1 : -1, i ? -0.004 : 0, 0, 0, 1], v * 9);
      lanes[v * 9 + 6] = packEntityLane(id, colorSaltByte(colour));
      vertices.set([v % 2, v >= 2 ? 1 : 0], v * 9 + 7);
    }
    const uniforms = new Float32Array(MESH_UNIFORM_FLOATS);
    uniforms.set(view.m); uniforms.set(MathUtils.identity().m, MESH_UNIFORM_OFFSET.model);
    uniforms.set(view.m, MESH_UNIFORM_OFFSET.rteViewProj); uniforms.set(colour, MESH_UNIFORM_OFFSET.baseColor);
    const texture = device.createTexture({ size: [2, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    resources.push(texture);
    // Front left is a genuine transparent texel; its right half is opaque.
    device.queue.writeTexture({ texture }, new Uint8Array([255, 255, 255, i ? 255 : 0, 255, 255, 255, 255]), { bytesPerRow: 8 }, [2, 1]);
    return { vertex: buffer(vertices, GPUBufferUsage.VERTEX),
      group: pipeline.createTexturedBindGroup(buffer(uniforms, GPUBufferUsage.UNIFORM), texture.createView(), sampler) };
  });
  const rows: { reverseDrawOrder: boolean; cutoutOwner: number; opaqueOwner: number }[] = [];
  try {
    await pipeline.visibility.prepare();
    for (const reverseDrawOrder of [false, true]) {
      const image = device.createTexture({ size: [64, 64], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }); resources.push(image);
      const encoder = device.createCommandEncoder();
      const pass = pipeline.visibility.begin(encoder, {
        colorAttachments: [
          { view: pipeline.getMultisampleTextureView()!, loadOp: 'clear', storeOp: 'store' },
          { view: pipeline.getObjectIdTextureView(), resolveTarget: image.createView(), loadOp: 'clear', storeOp: 'store' },
        ], depthStencilAttachment: { view: pipeline.getDepthTextureView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'store', stencilClearValue: 0 },
      }, true, 64, 64);
      pass.setPipeline(pipeline.getTexturedPipeline()); pass.setBindGroup(1, pipeline.getEnvironmentBindGroup()); pass.setIndexBuffer(index, 'uint32');
      for (const piece of reverseDrawOrder ? [...pieces].reverse() : pieces) {
        pass.setBindGroup(0, piece.group); pass.setVertexBuffer(0, piece.vertex);
        pass.drawIndexed(6, 1, 3); // The skipped prefix must remain skipped in the prepass.
      }
      pass.end();
      const read = device.createBuffer({ size: 64 * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); resources.push(read);
      encoder.copyTextureToBuffer({ texture: image }, { buffer: read, bytesPerRow: 256 }, [64, 64]);
      device.queue.submit([...takeOpaqueVisibilityCommands(encoder), encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(read.getMappedRange());
      const owner = (x: number) => { const p = 32 * 256 + x * 4; return bytes[p] * 65536 + bytes[p + 1] * 256 + bytes[p + 2]; };
      rows.push({ reverseDrawOrder, cutoutOwner: owner(20), opaqueOwner: owner(44) }); read.unmap();
    }
    await device.queue.onSubmittedWorkDone();
    return { frontId, rearId, rows, errors, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } };
  } finally { pipeline.destroy(); for (const resource of resources) resource.destroy(); device.destroy(); }
}
