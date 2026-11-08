/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EdgePass } from '../../packages/renderer/src/edge-pass.js';
import type { EdgeQuality } from '../../packages/renderer/src/edge-params.js';
import { MathUtils } from '../../packages/renderer/src/math.js';

/**
 * The real edge pass over one long straight edge, drawn slanted and drawn
 * axis-aligned, read back per pixel. The scene is three view-space quads
 * rasterised into the same depth (reverse-Z, `'greater'`) and object-id
 * attachments the main pass writes, so each of the edge pass's three cues can
 * be exercised on its own:
 *
 * - `crease`: one entity, its vertical face and its horizontal top (the top
 *   edge of a wall, where the dots were reported);
 * - `seam`: two entities on one plane (two walls meeting on a facade);
 * - `silhouette`: one entity, the face in front of a far plane;
 * - `hidden`: the crease behind a full-frame occluder, which must draw nothing.
 */

const WIDTH = 256;
const HEIGHT = 160;
const INTENSITY = 0.5;
/** Rows either side of the edge's projected line that belong to it. */
const BAND = 4;
/** Columns trimmed from each end of the edge, where its faces end. */
const TRIM = 8;

type Vec3 = [number, number, number];
export type EdgeCase = 'crease' | 'seam' | 'silhouette' | 'hidden';
export interface EdgeLineRow {
  edgeCase: EdgeCase; samples: number; quality: EdgeQuality; radius: number; slanted: boolean;
  /** Per column along the edge, the darkest pixel within `BAND` rows of it (0-255). */
  columnMax: number[];
  /** Per column, how many pixels within the band are darkened at all. */
  columnInk: number[];
  /** Darkest pixel anywhere in the frame. */
  frameMax: number;
}
export interface EdgeLineReport {
  adapter: { vendor: string; architecture: string; description: string };
  rows: EdgeLineRow[]; errors: string[];
}

const SCENE_WGSL = `
  struct Scene { proj: mat4x4<f32> }
  @group(0) @binding(0) var<uniform> scene: Scene;
  struct Out { @builtin(position) pos: vec4<f32>, @location(0) @interpolate(flat) id: u32 }
  @vertex fn vs(@location(0) p: vec3<f32>, @location(1) id: u32) -> Out {
    var o: Out; o.pos = scene.proj * vec4<f32>(p, 1.0); o.id = id; return o;
  }
  @fragment fn fs(i: Out) -> @location(0) vec4<f32> {
    return vec4<f32>(f32((i.id >> 16u) & 255u), f32((i.id >> 8u) & 255u), f32(i.id & 255u), 255.0) / 255.0;
  }
`;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Two triangles, each vertex `[x, y, z, id]`. */
function quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, id: number): number[][] {
  return [a, b, c, a, c, d].map(v => [...v, id]);
}

/** The edge runs from A to B, below eye level and receding to the right. */
function edgeEnds(slanted: boolean): [Vec3, Vec3] {
  const a: Vec3 = [-4, -3, -10];
  // Same y/z as A projects onto the same row: an axis-aligned control.
  return [a, slanted ? [4, -2.4, -12] : [4, -3.6, -12]];
}

function sceneQuads(edgeCase: EdgeCase, slanted: boolean): number[][] {
  const [a, b] = edgeEnds(slanted);
  const down: Vec3 = [0, -4, 0];
  const back: Vec3 = [0, 0, -3];
  const below = quad(a, b, add(b, down), add(a, down), 1);
  switch (edgeCase) {
    case 'crease':
      return [...below, ...quad(a, b, add(b, back), add(a, back), 1)];
    case 'seam':
      return [...below, ...quad(a, b, add(b, [0, 4, 0]), add(a, [0, 4, 0]), 2)];
    case 'silhouette':
      return [...below, ...quad([-60, -40, -30], [60, -40, -30], [60, 40, -30], [-60, 40, -30], 1)];
    case 'hidden':
      return [
        ...below, ...quad(a, b, add(b, back), add(a, back), 1),
        ...quad([-20, -20, -5], [20, -20, -5], [20, 20, -5], [-20, 20, -5], 3),
      ];
  }
}

/** Pixel of a view-space point: x right, y down, centres at +0.5. */
function toPixel(proj: Float32Array, p: Vec3): [number, number] {
  const w = -p[2];
  const x = (proj[0] * p[0] + proj[8] * p[2]) / w;
  const y = (proj[5] * p[1] + proj[9] * p[2]) / w;
  return [(x * 0.5 + 0.5) * WIDTH, (0.5 - y * 0.5) * HEIGHT];
}

/** Production EdgePass over a hand-built depth/id frame (#5385). */
export async function runEdgeLineWitness(): Promise<EdgeLineReport> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', e => errors.push(e.error.message));
  const owned: (GPUBuffer | GPUTexture)[] = [];
  const projection = MathUtils.perspectiveReverseZ(Math.PI / 3, WIDTH / HEIGHT, 0.1, 500);
  const uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  owned.push(uniform);
  device.queue.writeBuffer(uniform, 0, projection.m);
  const module = device.createShaderModule({ code: SCENE_WGSL });
  const rows: EdgeLineRow[] = [];
  try {
    for (const samples of [1, 4]) {
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 16, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'uint32' },
        ] }] },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'greater' },
        multisample: { count: samples },
      });
      const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
      const edges = new EdgePass(device, 'rgba8unorm', samples);
      try {
        for (const edgeCase of ['crease', 'seam', 'silhouette', 'hidden'] as const)
          for (const slanted of [false, true])
            for (const quality of ['low', 'high'] as const)
              for (const radius of [1, 2]) {
                const verts = sceneQuads(edgeCase, slanted);
                const data = new ArrayBuffer(verts.length * 16);
                const f = new Float32Array(data); const u = new Uint32Array(data);
                verts.forEach((v, i) => { f.set(v.slice(0, 3), i * 4); u[i * 4 + 3] = v[3]; });
                const vertex = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
                owned.push(vertex);
                device.queue.writeBuffer(vertex, 0, data);
                const attachment = (format: GPUTextureFormat, count: number, usage: GPUTextureUsageFlags) => {
                  const t = device.createTexture({ size: [WIDTH, HEIGHT], format, sampleCount: count, usage }); owned.push(t); return t;
                };
                const depth = attachment('depth24plus-stencil8', samples, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
                const ids = attachment('rgba8unorm', samples, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
                const target = attachment('rgba8unorm', 1, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
                const encoder = device.createCommandEncoder();
                const scene = encoder.beginRenderPass({
                  colorAttachments: [{ view: ids.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
                  depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0,
                    stencilLoadOp: 'clear', stencilStoreOp: 'store', stencilClearValue: 0 },
                });
                scene.setPipeline(pipeline); scene.setBindGroup(0, bindGroup); scene.setVertexBuffer(0, vertex);
                scene.draw(verts.length); scene.end();
                // Edges darken whatever is already there; white makes the darkening the readback.
                encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] }] }).end();
                edges.encode({
                  encoder, targetView: target.createView(), depthView: depth.createView({ aspect: 'depth-only' }), objectIdView: ids.createView(),
                  params: { projection, width: WIDTH, height: HEIGHT, quality, radiusPx: radius, intensity: INTENSITY },
                });
                const dark = await readDarkening(device, encoder, target);
                const [pa, pb] = edgeEnds(slanted).map(p => toPixel(projection.m, p));
                const columnMax: number[] = []; const columnInk: number[] = [];
                for (let x = Math.ceil(pa[0]) + TRIM; x < Math.floor(pb[0]) - TRIM; x++) {
                  const lineY = pa[1] + ((x + 0.5 - pa[0]) * (pb[1] - pa[1])) / (pb[0] - pa[0]);
                  let max = 0; let ink = 0;
                  for (let y = Math.floor(lineY) - BAND; y <= Math.floor(lineY) + BAND; y++) {
                    const v = dark[y * WIDTH + x]; max = Math.max(max, v); if (v > 0) ink++;
                  }
                  columnMax.push(max); columnInk.push(ink);
                }
                rows.push({ edgeCase, samples, quality, radius, slanted, columnMax, columnInk, frameMax: Math.max(...dark) });
              }
      } finally { edges.destroy(); }
    }
    await device.queue.onSubmittedWorkDone();
    return { adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description }, rows, errors };
  } finally { for (const r of owned) r.destroy(); device.destroy(); }
}

/** 255 minus the red channel of every pixel: how much the edge pass darkened white. */
async function readDarkening(device: GPUDevice, encoder: GPUCommandEncoder, target: GPUTexture): Promise<number[]> {
  const bytesPerRow = WIDTH * 4;
  const read = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    encoder.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow }, [WIDTH, HEIGHT]);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(read.getMappedRange());
    const out = Array.from({ length: WIDTH * HEIGHT }, (_, i) => 255 - bytes[i * 4]);
    read.unmap();
    return out;
  } finally { read.destroy(); }
}
