/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { PIPELINE_CONSTANTS } from './constants.js';
import type { ReferenceImageInput } from './reference-image-types.js';

const SHADER = `
struct Uniforms { viewProj: mat4x4<f32>, clipOrigin: vec4<f32>, settings: vec4<f32> }
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var raster: texture_2d<f32>;
@group(0) @binding(2) var rasterSampler: sampler;
struct Vertex { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex fn vs(@location(0) position: vec3<f32>, @location(1) uv: vec2<f32>) -> Vertex {
  var out: Vertex;
  out.position = u.viewProj * vec4<f32>(position, 0.0) + u.clipOrigin;
  out.uv = uv; return out;
}
@fragment fn fs(v: Vertex) -> @location(0) vec4<f32> {
  let pixel = textureSample(raster, rasterSampler, v.uv);
  let alpha = pixel.a * u.settings.x;
  if (alpha < 0.001) { discard; }
  return vec4<f32>(pixel.rgb * alpha, alpha);
}`;

export interface ReferenceGpuImage {
  input: ReferenceImageInput;
  draw(pass: GPURenderPassEncoder, viewProj: Float32Array): void;
  destroy(): void;
}

/** Owns only uploaded pixels and quad buffers; source bitmaps belong to the inventory. */
export class ReferenceImagePipeline {
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  constructor(private device: GPUDevice, format: GPUTextureFormat, sampleCount: number) {
    const module = device.createShaderModule({ label: 'reference-image', code: SHADER });
    this.pipeline = device.createRenderPipeline({ label: 'reference-image', layout: 'auto',
      vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 20, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x2' },
      ] }] },
      fragment: { module, entryPoint: 'fs', targets: [{ format, blend: {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      } }, { format: 'rgba8unorm', writeMask: 0 }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: PIPELINE_CONSTANTS.DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'greater-equal' },
      multisample: { count: sampleCount },
    });
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  }

  upload(input: ReferenceImageInput): ReferenceGpuImage {
    const { device } = this;
    if (!input.id || !Number.isFinite(input.opacity) || input.opacity < 0 || input.opacity > 1 ||
      input.corners.length !== 4 || input.corners.some(p => p.length !== 3 || p.some(n => !Number.isFinite(n)))) {
      throw new Error('Reference image requires a stable ID, four finite corners and opacity between zero and one.');
    }
    if (input.bitmap.width < 1 || input.bitmap.height < 1 || Math.max(input.bitmap.width, input.bitmap.height) > device.limits.maxTextureDimension2D) {
      throw new Error('Reference image exceeds this GPU’s image dimensions. Choose a lower raster resolution.');
    }
    const origin = input.corners[0];
    const uv = [[0,0], [1,0], [1,1], [0,1]];
    const vertices = new Float32Array([0,1,2,0,2,3].flatMap(i => [
      input.corners[i][0]-origin[0], input.corners[i][1]-origin[1], input.corners[i][2]-origin[2], ...uv[i],
    ]));
    if (vertices.some(n => !Number.isFinite(n))) throw new Error('Reference dimensions exceed the renderable coordinate range.');
    const resources: { destroy(): void }[] = [];
    try {
      const texture = device.createTexture({ label: 'reference-image', size: [input.bitmap.width, input.bitmap.height], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      resources.push(texture);
      device.queue.copyExternalImageToTexture({ source: input.bitmap }, { texture }, [input.bitmap.width, input.bitmap.height]);
      const buffer = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      resources.push(buffer);
      device.queue.writeBuffer(buffer, 0, vertices);
      const uniform = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      resources.push(uniform);
      const bind = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: texture.createView() }, { binding: 2, resource: this.sampler },
      ] });
      const data = new Float32Array(24);
      let destroyed = false;
      return { input,
        draw: (pass, viewProj) => {
          if (destroyed || !input.visible || input.opacity === 0) return;
          data.set(viewProj, 0);
          for (let row = 0; row < 4; row++) data[16+row] = viewProj[row]*origin[0]+viewProj[4+row]*origin[1]+viewProj[8+row]*origin[2]+viewProj[12+row];
          data[20] = input.opacity;
          device.queue.writeBuffer(uniform, 0, data);
          pass.setPipeline(this.pipeline); pass.setBindGroup(0, bind); pass.setVertexBuffer(0, buffer); pass.draw(6);
        },
        destroy: () => { if (!destroyed) { destroyed = true; for (const resource of resources) resource.destroy(); } },
      };
    } catch (error) {
      for (const resource of resources) resource.destroy();
      throw error;
    }
  }
}
