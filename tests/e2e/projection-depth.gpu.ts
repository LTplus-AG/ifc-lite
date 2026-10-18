/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MathUtils } from '../../packages/renderer/src/math.js';
import { MESH_UNIFORM_FLOATS, MESH_UNIFORM_OFFSET } from '../../packages/renderer/src/mesh-rte-uniforms.js';
import { mainShaderSource } from '../../packages/renderer/src/shaders/main.wgsl.js';
import { depthNudgeWgsl } from '../../packages/renderer/src/shaders/depth-nudge.wgsl.js';
import { colorSaltByte, packEntityLane } from '../../packages/renderer/src/scene-geometry.js';
import { quantizeInterleaved } from '../../packages/renderer/src/quantize.js';
import { INSTANCED_VERTEX_BUFFERS } from '../../packages/renderer/src/instanced-vertex-layout.js';
import { packRteOrigin } from '../../packages/renderer/src/relative-to-eye.js';
import { OpaqueVisibilityPass } from '../../packages/renderer/src/opaque-visibility-pass.js';
import { takeOpaqueVisibilityCommands } from '../../packages/renderer/src/opaque-visibility-commands.js';
import {
  DEPTH_SIZE, PROBE_MIN, PROBE_MAX, ORBIT_ANGLES, DEPTH_RANGES, DEPTH_GAPS,
  EYE_DISTANCE, FOV, HALF_HEIGHT, orbitEye, geometricOracle, squarePositions, type Projection,
} from './projection-depth.fixture.js';

type Family = 'flat' | 'quantized' | 'instanced';
type Mode = 'production' | 'zero-nudge';
const COLOR = [0.8, 0.2, 0.1, 1] as const;
const INDICES = new Uint32Array([0, 1, 2, 2, 1, 3]);
const FLAT_LAYOUT: GPUVertexBufferLayout = { arrayStride: 28, attributes: [
  { shaderLocation: 0, offset: 0, format: 'float32x3' },
  { shaderLocation: 1, offset: 12, format: 'float32x3' },
  { shaderLocation: 2, offset: 24, format: 'uint32' },
] };
const QUANT_LAYOUT: GPUVertexBufferLayout = { arrayStride: 12, attributes: [
  { shaderLocation: 0, offset: 0, format: 'uint16x4' },
  { shaderLocation: 2, offset: 8, format: 'uint32' },
] };

/** Preserve production vertex stages; change ONLY nudge for the causal control. */
const ZERO_NUDGE = 'fn nudgedClipZ(clip: vec4<f32>, zHash: u32, viewProj: mat4x4<f32>) -> f32 { return clip.z; }';
const zeroNudgeSource = mainShaderSource.replace(depthNudgeWgsl, ZERO_NUDGE);

function entityForHash(hash: number, family: Family): { id: number; lane: number } {
  for (let id = 1; id <= 256; id++) {
    const salt = family === 'instanced' ? 0 : colorSaltByte(COLOR);
    const lane = packEntityLane(id, salt);
    const mixed = (id & 0xffffff) ^ Math.imul(salt, 2654435761);
    if ((Math.imul(mixed, 2654435761) & 255) === hash) return { id, lane };
  }
  throw new Error('No entity with the requested depth rank');
}

export interface ProjectionDepthRow {
  family: Family; samples: number; projection: Projection; mode: Mode;
  range: number | null; gap: number; angle: number; reverseDrawOrder: boolean;
  renderedGap: number;
  frontId: number; rearId: number; frontLane: number; rearLane: number;
  frontPixels: number; rearPixels: number; otherPixels: number;
  viewProjection: number[];
  oracle: ReturnType<typeof geometricOracle>;
}
export interface ProjectionDepthReport {
  scope: string; adapter: { vendor: string; architecture: string; device: string; description: string };
  userAgent: string; shaderSHA256: Record<Mode, string>; rows: ProjectionDepthRow[]; errors: string[];
}

/** Actual colour vertex stages, depth format and MSAA; ID colours replace lighting only. */
export async function runProjectionDepthWitness(): Promise<ProjectionDepthReport> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable; no projection witness ran');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  device.lost.then(info => { if (info.reason !== 'destroyed') errors.push(`Device lost: ${info.message}`); });
  const rows: ProjectionDepthRow[] = [];
  const sources = { production: mainShaderSource, 'zero-nudge': zeroNudgeSource };
  const digest = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(v => v.toString(16).padStart(2, '0')).join('');
  const shaderSHA256 = { production: await digest(sources.production), 'zero-nudge': await digest(sources['zero-nudge']) };
  const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
  const owned: GPUBuffer[] = [];
  const buffer = (data: ArrayBufferView, usage: GPUBufferUsageFlags) => {
    const result = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(result, 0, data.buffer, data.byteOffset, data.byteLength);
    owned.push(result); return result;
  };
  try {
    if (shaderSHA256.production === shaderSHA256['zero-nudge']) throw new Error('Diagnostic shader did not remove the nudge');
    const index = buffer(INDICES, GPUBufferUsage.INDEX);
    for (const family of ['flat', 'quantized', 'instanced'] as const) {
      const front = entityForHash(0, family), rear = entityForHash(255, family);
      // Only the real vertex stage computes the displaced depth. This fragment
      // reports front=red/rear=green, independently of shading or selection.
      const witnessFragment = `
        @fragment fn fs_witness(input: VertexOutput)->@location(0) vec4<f32> {
          if ((input.entityId & 0x00ffffffu) == ${front.id}u) { return vec4<f32>(1,0,0,1); }
          return vec4<f32>(0,1,0,1);
        }`;
      for (const samples of [1, 4]) for (const mode of ['production', 'zero-nudge'] as const) {
        const visibility = new OpaqueVisibilityPass(device, samples);
        const source = sources[mode] + witnessFragment;
        const shader = device.createShaderModule({ code: source });
        const descriptor: GPURenderPipelineDescriptor = {
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout, device.createBindGroupLayout({ entries: [] })] }),
          vertex: { module: shader, entryPoint: family === 'flat' ? 'vs_main' : family === 'quantized' ? 'vs_main_quantized' : 'vs_instanced',
            buffers: family === 'instanced' ? INSTANCED_VERTEX_BUFFERS : [family === 'flat' ? FLAT_LAYOUT : QUANT_LAYOUT] },
          fragment: { module: shader, entryPoint: 'fs_witness', targets: [{ format: 'rgba8unorm' }] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'greater' },
          multisample: { count: samples },
        };
        const pipeline = mode === 'production' ? await visibility.createAsync(descriptor, source) : await device.createRenderPipelineAsync(descriptor);
        if (mode === 'production') await visibility.prepare(pipeline);
        try {
        for (const gap of DEPTH_GAPS) for (const angle of ORBIT_ANGLES)
          for (const projection of ['perspective', 'orthographic'] as const)
          for (const range of projection === 'orthographic' ? DEPTH_RANGES : [null])
          for (const reverseDrawOrder of [false, true]) {
            const mark = owned.length;
            try {
              const eye = orbitEye(angle);
              const view = MathUtils.lookAt({ x: eye[0], y: eye[1], z: eye[2] }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
              const proj = projection === 'orthographic'
                ? MathUtils.orthographicReverseZ(-HALF_HEIGHT, HALF_HEIGHT, -HALF_HEIGHT, HALF_HEIGHT, EYE_DISTANCE - range! / 2, EYE_DISTANCE + range! / 2)
                : MathUtils.perspectiveReverseZ(FOV, 1, 0.01, 1000);
              const vp = MathUtils.multiply(proj, view);
              const rotation = { m: view.m.slice() }; rotation.m[12] = 0; rotation.m[13] = 0; rotation.m[14] = 0;
              const rteVp = MathUtils.multiply(proj, rotation);
              const pieces = [front, rear].map((entity, i) => {
                const positions = squarePositions(i === 0 ? 0 : -gap);
                const packed = new Float32Array(28), lanes = new Uint32Array(packed.buffer);
                for (let v = 0; v < 4; v++) {
                  packed.set(positions.subarray(v * 3, v * 3 + 3), v * 7); packed[v * 7 + 5] = 1; lanes[v * 7 + 6] = entity.lane;
                }
                const quant = family === 'quantized' ? quantizeInterleaved(packed, 7) : null;
                if (family === 'quantized' && !quant) throw new Error('Small square failed quantization');
                const uniform = new Float32Array(MESH_UNIFORM_FLOATS);
                uniform.set(vp.m); uniform.set(MathUtils.identity().m, MESH_UNIFORM_OFFSET.model);
                uniform.set(COLOR, MESH_UNIFORM_OFFSET.baseColor); uniform.set(rteVp.m, MESH_UNIFORM_OFFSET.rteViewProj);
                if (quant) uniform.set([...quant.quantMin, quant.step], MESH_UNIFORM_OFFSET.quantParams);
                const record = new Float32Array(22); record.set(MathUtils.identity().m);
                new Uint32Array(record.buffer)[16] = entity.id; record.set(COLOR, 17);
                const delta = new Float32Array(8); packRteOrigin([-eye[0], -eye[1], -eye[2]], delta, 0);
                const gpuUniform = buffer(uniform, GPUBufferUsage.UNIFORM);
                return {
                  planeZ: quant ? quant.quantMin[2] + new Uint16Array(quant.vertexData)[2] * quant.step : positions[2],
                  vertex: buffer(quant ? new Uint8Array(quant.vertexData) : packed, GPUBufferUsage.VERTEX),
                  instance: family === 'instanced' ? buffer(record, GPUBufferUsage.VERTEX) : null,
                  delta: family === 'instanced' ? buffer(delta, GPUBufferUsage.VERTEX) : null,
                  bindGroup: device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: gpuUniform } }] }),
                };
              });
              const counts = await drawReadback(device, visibility, projection === 'orthographic' && mode === 'production', pipeline, index, reverseDrawOrder ? [...pieces].reverse() : pieces, samples);
              const renderedGap = pieces[0].planeZ - pieces[1].planeZ;
              rows.push({ family, samples, projection, mode, range, gap, angle, reverseDrawOrder,
                renderedGap,
                frontId: front.id, rearId: rear.id, frontLane: front.lane, rearLane: rear.lane,
                ...counts, viewProjection: Array.from(vp.m), oracle: geometricOracle(projection, angle, renderedGap) });
            } finally { for (const b of owned.splice(mark)) b.destroy(); }
          }
        } finally { visibility.destroy(); }
      }
    }
    await device.queue.onSubmittedWorkDone();
    return { scope: 'Synthetic separated opaque squares through production colour vertex stages; independent ray/plane visibility; diagnostic fragment, no IFC import, selection or full viewer acceptance',
      adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description },
      userAgent: navigator.userAgent, shaderSHA256, rows, errors };
  } finally { for (const b of owned) b.destroy(); device.destroy(); }
}

interface Piece { vertex: GPUBuffer; instance: GPUBuffer | null; delta: GPUBuffer | null; bindGroup: GPUBindGroup }
async function drawReadback(device: GPUDevice, visibility: OpaqueVisibilityPass, orthographic: boolean, pipeline: GPURenderPipeline, index: GPUBuffer, pieces: Piece[], samples: number) {
  const color = device.createTexture({ size: [DEPTH_SIZE, DEPTH_SIZE], sampleCount: samples, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | (samples === 1 ? GPUTextureUsage.COPY_SRC : 0) });
  const resolved = samples === 1 ? color : device.createTexture({ size: [DEPTH_SIZE, DEPTH_SIZE], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const depth = device.createTexture({ size: [DEPTH_SIZE, DEPTH_SIZE], sampleCount: samples, format: 'depth24plus-stencil8', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const read = device.createBuffer({ size: DEPTH_SIZE * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    const pass = visibility.begin(encoder, { colorAttachments: [{ view: color.createView(), ...(samples === 1 ? {} : { resolveTarget: resolved.createView() }), loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'store', stencilClearValue: 0 } }, orthographic, DEPTH_SIZE, DEPTH_SIZE);
    pass.setPipeline(pipeline); pass.setIndexBuffer(index, 'uint32');
    for (const piece of pieces) {
      pass.setBindGroup(0, piece.bindGroup); pass.setVertexBuffer(0, piece.vertex);
      if (piece.instance && piece.delta) { pass.setVertexBuffer(1, piece.instance); pass.setVertexBuffer(2, piece.delta); }
      pass.drawIndexed(6);
    }
    pass.end(); encoder.copyTextureToBuffer({ texture: resolved }, { buffer: read, bytesPerRow: 256 }, [DEPTH_SIZE, DEPTH_SIZE]);
    device.queue.submit([...takeOpaqueVisibilityCommands(encoder), encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
    const rgba = new Uint8Array(read.getMappedRange());
    let frontPixels = 0, rearPixels = 0, otherPixels = 0;
    for (let y = PROBE_MIN; y < PROBE_MAX; y++) for (let x = PROBE_MIN; x < PROBE_MAX; x++) {
      const offset = y * 256 + x * 4;
      if (rgba[offset] === 255 && rgba[offset + 1] === 0) frontPixels++;
      else if (rgba[offset + 1] > 0) rearPixels++; // Includes even ONE leaked MSAA sample after resolve.
      else otherPixels++;
    }
    read.unmap(); return { frontPixels, rearPixels, otherPixels };
  } finally { read.destroy(); depth.destroy(); if (resolved !== color) resolved.destroy(); color.destroy(); }
}
