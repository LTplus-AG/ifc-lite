/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SelectionMaskPass } from '../../packages/renderer/src/selection-mask-pass.js';
import { mainShaderSource } from '../../packages/renderer/src/shaders/main.wgsl.js';
import { uploadIndividualMesh } from '../../packages/renderer/src/individual-mesh-upload.js';
import { quantizeInterleaved } from '../../packages/renderer/src/quantize.js';
import { INSTANCED_VERTEX_BUFFERS } from '../../packages/renderer/src/instanced-vertex-layout.js';
import { uploadInstancedRteDeltas } from '../../packages/renderer/src/instanced-rte.js';
import type { WebGPUDevice } from '../../packages/renderer/src/device.js';
import type { InstancedMaskTemplate } from '../../packages/renderer/src/selection-mask-pipelines.js';

const SIZE = 64;
const ID = 256; // Hash zero isolates visibility from the separate mesh-nudge contract.
const flatLayout: GPUVertexBufferLayout = {
  arrayStride: 28, attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'uint32' },
  ],
};
const quantLayout: GPUVertexBufferLayout = { arrayStride: 12, attributes: [
  { shaderLocation: 0, offset: 0, format: 'uint16x4' },
  { shaderLocation: 2, offset: 8, format: 'uint32' },
] };
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

type Family = 'flat' | 'quantized' | 'instanced';
export interface MaskDepthRow {
  samples: number; family: Family; perspective: boolean; slope: number;
  case: 'same-source' | 'occluded-1mm' | 'transparent-front' | 'transparent-selected';
  selected: number; hovered: number; all: number;
}
export interface MaskDepthReport {
  adapter: { vendor: string; architecture: string; device: string; description: string };
  rows: MaskDepthRow[]; errors: string[];
}

/** Actual main vertex stages, canonical individual upload and mask passes (#6729). */
export async function runMaskDepthWitness(sampledDepthView = false): Promise<MaskDepthReport> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', e => errors.push(e.error.message));
  const rows: MaskDepthRow[] = [];
  const owned: (GPUBuffer | GPUTexture)[] = [];
  const buffer = (data: ArrayBuffer | ArrayBufferView, usage: GPUBufferUsageFlags) => {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const b = device.createBuffer({ size: bytes.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, bytes); owned.push(b); return b;
  };
  const meshLayout = device.createBindGroupLayout({ entries: [{ binding: 0,
    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
  const shader = device.createShaderModule({ code: mainShaderSource });
  const indices = buffer(new Uint32Array([0, 1, 2, 2, 1, 3]), GPUBufferUsage.INDEX);
  try {
    for (const samples of [1, 4]) for (const family of ['flat', 'quantized', 'instanced'] as const)
      for (const perspective of [false, true]) for (const slope of [0, 0.125]) {
        const projection = identity();
        if (perspective) {
          // Reverse-Z infinite projection: depth=near/distance, camera at z=0.
          projection[10] = 0; projection[11] = -1; projection[14] = 1; projection[15] = 0;
        } else { projection[10] = 0.001; projection[14] = 0.5; }
        const uniforms = new Float32Array(96);
        uniforms.set(projection); uniforms.set(identity(), 16); uniforms.set(projection, 60);
        const positions = new Float32Array([-1, -1, -2.0003 - slope, 1, -1, -2.0003 + slope, -1, 1, -2.0003 - slope, 1, 1, -2.0003 + slope]);
        const normals = new Float32Array(12); for (let i = 2; i < 12; i += 3) normals[i] = 1;
        const mesh = { expressId: ID, positions, normals, indices: new Uint32Array([0, 1, 2, 2, 1, 3]), color: [0, 0, 0, 1] as [number, number, number, number] };
        const individual = uploadIndividualMesh(device, mesh, { sharedOrigin: null, quantized: family === 'quantized' });
        owned.push(individual.vertexBuffer, individual.indexBuffer);
        // Build the scene from the exact canonical upload; quantized scene decodes its lattice.
        const packed = new Float32Array(28); const ids = new Uint32Array(packed.buffer);
        for (let i = 0; i < 4; i++) { packed.set(positions.subarray(i * 3, i * 3 + 3), i * 7); packed[i * 7 + 5] = 1; ids[i * 7 + 6] = ID; }
        let vertex = buffer(packed, GPUBufferUsage.VERTEX);
        if (family === 'quantized') {
          const quant = quantizeInterleaved(packed, 7);
          if (!quant) throw new Error('Witness unexpectedly exceeded quantization envelope');
          vertex = buffer(quant.vertexData, GPUBufferUsage.VERTEX); uniforms.set([...quant.quantMin, quant.step], 56);
        }
        const uniform = buffer(uniforms, GPUBufferUsage.UNIFORM);
        const bindGroup = device.createBindGroup({ layout: meshLayout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
        const record = new Float32Array(22); record.set(identity()); new Uint32Array(record.buffer)[16] = ID; record.set([0, 0, 0, 1], 17); new Uint32Array(record.buffer)[21] = 1;
        const template: InstancedMaskTemplate = {
          vertexBuffer: vertex, indexBuffer: indices, indexCount: 6, instanceCount: 1,
          instanceBuffer: buffer(record, GPUBufferUsage.VERTEX), canonicalAnchors: new Float64Array(3),
          rteDeltas: { buffer: buffer(new Float32Array(8), GPUBufferUsage.VERTEX), scratch: new Float32Array(8), camera: null, runs: [] },
        };
        uploadInstancedRteDeltas(device, [template], [0, 0, 0]);
        const vertexState: GPUVertexState = { module: shader,
          entryPoint: family === 'instanced' ? 'vs_instanced' : family === 'quantized' ? 'vs_main_quantized' : 'vs_main',
          buffers: family === 'instanced' ? INSTANCED_VERTEX_BUFFERS : [family === 'quantized' ? quantLayout : flatLayout] };
        const scenePipeline = (writes: boolean) => device.createRenderPipeline({
          layout: device.createPipelineLayout({ bindGroupLayouts: [meshLayout] }), vertex: vertexState,
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: writes, depthCompare: 'greater' }, multisample: { count: samples },
        });
        const opaque = scenePipeline(true), transparent = scenePipeline(false);
        const mask = new SelectionMaskPass({ getDevice: () => device } as WebGPUDevice, meshLayout, samples);
        try {
          for (const kind of ['same-source', 'occluded-1mm', 'transparent-front', 'transparent-selected'] as const) {
            const depth = device.createTexture({ size: [SIZE, SIZE], format: 'depth24plus-stencil8', sampleCount: samples, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }); owned.push(depth);
            const encoder = device.createCommandEncoder();
            const scene = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
              view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0,
              stencilLoadOp: 'clear', stencilStoreOp: 'store', stencilClearValue: 0,
            } });
            scene.setPipeline(opaque); scene.setBindGroup(0, bindGroup); scene.setVertexBuffer(0, vertex); scene.setIndexBuffer(indices, 'uint32');
            if (family === 'instanced') { scene.setVertexBuffer(1, template.instanceBuffer); scene.setVertexBuffer(2, template.rteDeltas.buffer); }
            // Alter the model's world z, retaining all source rasterization inputs.
            const offset = kind === 'occluded-1mm' ? 0.001 : kind === 'transparent-selected' ? -0.001 : 0;
            const moved = uniforms.slice(); moved[30] = offset;
            if (family === 'instanced') {
              const movedRecord = record.slice();
              movedRecord[14] = offset;
              scene.setVertexBuffer(1, buffer(movedRecord, GPUBufferUsage.VERTEX));
              scene.setVertexBuffer(2, buffer(new Float32Array([0, 0, offset, 0, 0, 0, 0, 0]), GPUBufferUsage.VERTEX));
            }
            const movedGroup = device.createBindGroup({ layout: meshLayout, entries: [{ binding: 0,
              resource: { buffer: buffer(moved, GPUBufferUsage.UNIFORM) } }] });
            scene.setBindGroup(0, movedGroup);
            scene.drawIndexed(6);
            if (kind === 'transparent-front') {
              scene.setPipeline(transparent);
              if (family === 'instanced') {
                const frontRecord = record.slice();
                frontRecord[14] = 0.001;
                scene.setVertexBuffer(1, buffer(frontRecord, GPUBufferUsage.VERTEX));
                scene.setVertexBuffer(2, buffer(new Float32Array([0, 0, 0.001, 0, 0, 0, 0, 0]), GPUBufferUsage.VERTEX));
              }
              const front = moved.slice();
              front[30] = 0.001;
              scene.setBindGroup(0, device.createBindGroup({ layout: meshLayout, entries: [{ binding: 0,
                resource: { buffer: buffer(front, GPUBufferUsage.UNIFORM) } }] }));
              scene.drawIndexed(6);
            }
            scene.end();
            // Instanced uniforms are shared but GPU writes complete before submit;
            // distinct source/mask vertex state is prepared below using its own record.
            const views = mask.encode({ encoder, width: SIZE, height: SIZE, depthView: depth.createView({ aspect: sampledDepthView ? 'depth-only' : 'all' }),
              selected: family === 'instanced' ? [] : [{ ...individual, bindGroup }],
              hovered: family === 'instanced' ? [] : [{ ...individual, bindGroup }],
              ...(family === 'instanced' ? { instanced: { uniforms, rteCamera: [0, 0, 0] as const, selected: [template], hovered: [template], hoveredId: ID } } : {}),
            });
            const visible = await readMask(device, encoder, views.visibleView);
            const all = await readMask(device, device.createCommandEncoder(), views.allView);
            rows.push({ samples, family, perspective, slope, case: kind, selected: visible[0], hovered: visible[1], all: all[0] });
          }
        } finally { mask.destroy(); }
      }
    await device.queue.onSubmittedWorkDone();
    return { adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description }, rows, errors };
  } finally { for (const resource of owned) resource.destroy(); device.destroy(); }
}

async function readMask(device: GPUDevice, encoder: GPUCommandEncoder, source: GPUTextureView): Promise<[number, number]> {
  const module = device.createShaderModule({ code: `
    @group(0) @binding(0) var mask: texture_2d<f32>;
    @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32> {
      return vec4<f32>(array<vec2<f32>,3>(vec2<f32>(-1,-1),vec2<f32>(3,-1),vec2<f32>(-1,3))[i],0,1);
    }
    @fragment fn fs(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32> { return textureLoad(mask,vec2<i32>(p.xy),0); }
  ` });
  const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } });
  const target = device.createTexture({ size: [SIZE, SIZE], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const read = device.createBuffer({ size: SIZE * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }] }); pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: source }] })); pass.draw(3); pass.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow: 256 }, [SIZE, SIZE]); device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(read.getMappedRange()); const counts: [number, number] = [0, 0];
    for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) { if (bytes[y * 256 + x * 4]) counts[0]++; if (bytes[y * 256 + x * 4 + 1]) counts[1]++; }
    read.unmap(); return counts;
  } finally { target.destroy(); read.destroy(); }
}
