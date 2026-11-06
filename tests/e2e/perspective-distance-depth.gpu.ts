/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Perspective witness for #7955 (spandrel panels vanish when zooming out).
 *
 * Separated: a thin facade panel a few millimetres to centimetres in front of
 * a wall, from the distances a facade is browsed at. The wall gets the highest
 * entity depth hash and the panel the lowest, so any entity-rank displacement
 * works against geometry. Two camera states: the orbit target on the facade,
 * and the target only 5 m ahead of the camera (walk, fast zoom, a pan after a
 * close zoom), so the near plane is small while the facade is far.
 *
 * Coplanar: two overlapping faces of different entities on one plane, the
 * higher hash 255 and the lower 255 - delta, triangulated along opposite
 * diagonals so their interpolation noise differs as it does between real
 * meshes. This measures how far each hash separation stays ranked.
 *
 * Crease: two faces of different entities crossing along a slanted line, at
 * 4x MSAA. Pixels the line crosses must resolve to a blend of both, as with
 * fixed-function depth: one frag_depth per pixel instead of per sample would
 * decide every such pixel for one face, and creases (mullions, slab edges)
 * alias into stair steps. That control is drawn too, so the witness can see
 * the regression.
 *
 * Production vertex stage (the nudge lives there), fixed-function depth,
 * depth format and MSAA count; only lighting is replaced by an ID colour.
 * Every separated pose is also drawn with the nudge removed, which is the
 * geometric reference.
 */

import { MathUtils } from '../../packages/renderer/src/math.js';
import { MESH_UNIFORM_FLOATS, MESH_UNIFORM_OFFSET } from '../../packages/renderer/src/mesh-rte-uniforms.js';
import { mainShaderSource } from '../../packages/renderer/src/shaders/main.wgsl.js';
import { depthNudgeWgsl, PERSPECTIVE_DEPTH_NUDGE_LEVEL_SHIFT } from '../../packages/renderer/src/shaders/depth-nudge.wgsl.js';
import { colorSaltByte, packEntityLane } from '../../packages/renderer/src/scene-geometry.js';
import { PIPELINE_CONSTANTS } from '../../packages/renderer/src/constants.js';
import { Camera } from '../../packages/renderer/src/camera.js';

export const DISTANCES = [10, 30, 60, 100, 150] as const;
export const GAPS = [0.005, 0.01, 0.02] as const;
export const ANGLES = [0, 45, 70] as const;
export const TARGETS = ['on-facade', 'near-camera'] as const;
export const COPLANAR_DISTANCES = [5, 10, 30, 60, 100, 150, 300] as const;
export const COPLANAR_DELTAS = [1, 2, 4, 8, 16, 32, 64, 128, 255] as const;
export const SHIFT_DISTANCES = [1, 4, 7, 10, 30, 100, 300, 1000] as const;
export const CREASE_DISTANCES = [4, 10, 30, 60, 100, 150] as const;
export const CREASE_VARIANTS = ['production', 'pixel-centre'] as const;
/** The nudge removed: the geometric reference, and the causal control. */
export const ZERO_NUDGE = 'fn nudgedClipZ(clip: vec4<f32>, zHash: u32, viewProj: mat4x4<f32>) -> f32 { return clip.z; }';
/** The perspective vertex nudge before #7955 (256 levels), for before/after diagnostics only. */
export const UNBOUNDED_NUDGE = 'fn nudgedClipZ(clip: vec4<f32>, zHash: u32, viewProj: mat4x4<f32>) -> f32 { return clip.z * (1.0 + f32(zHash) * 1e-6); }';
/** The entity rank the production perspective nudge keeps (depth-nudge.wgsl.ts). */
export const nudgeLevel = (hash: number) => hash >> PERSPECTIVE_DEPTH_NUDGE_LEVEL_SHIFT;

type Target = typeof TARGETS[number];
const SIZE = 64, PROBE_MIN = 28, PROBE_MAX = 36, FOV = Math.PI / 4;
/**
 * The 64 px target is the centre of a virtual `SIZE * ZOOM` px canvas: clip x
 * and y are scaled, z and w (all of the depth arithmetic) are untouched. At
 * 64 px and a 45 degree field one pixel spans metres of depth on a grazing
 * face, and rasterizer sub-pixel error alone would exceed a 5 mm gap.
 */
const ZOOM = 16;
const COLOR = [0.8, 0.2, 0.1, 1] as const;
/**
 * Each square is a GRID x GRID mesh (`fine`) or two triangles (`coarse`). The
 * two entities use opposite diagonals, so coplanar faces never share
 * interpolation.
 */
export const GRID = 16;
/**
 * Coplanar `coarse` family: each square is two triangles, so a triangle
 * reaches from beside the camera to twice the distance, like a long slab or
 * wall. A vertex-stage bound interpolated its factor across such a triangle
 * (#7955 review); a level, the same factor at every vertex, must rank it like a fine mesh.
 */
export type Mesh = 'fine' | 'coarse';
function gridIndices(flip: boolean, n: number): Uint32Array {
  const out: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    out.push(...(flip ? [a, b, d, a, d, c] : [a, b, c, c, b, d]));
  }
  return new Uint32Array(out);
}
const cells = (mesh: Mesh) => mesh === 'fine' ? GRID : 1;
const LAYOUT: GPUVertexBufferLayout = { arrayStride: 28, attributes: [
  { shaderLocation: 0, offset: 0, format: 'float32x3' },
  { shaderLocation: 1, offset: 12, format: 'float32x3' },
  { shaderLocation: 2, offset: 24, format: 'uint32' },
] };

function entityForHash(hash: number, after = 0): { id: number; lane: number } {
  for (let id = after + 1; id <= 4096; id++) {
    const salt = colorSaltByte(COLOR);
    const lane = packEntityLane(id, salt);
    const mixed = (id & 0xffffff) ^ Math.imul(salt, 2654435761);
    if ((Math.imul(mixed, 2654435761) & 255) === hash) return { id, lane };
  }
  throw new Error('No entity with the requested depth rank');
}

export interface SeparatedRow {
  samples: number; distance: number; gap: number; angle: number; target: Target; reverseDrawOrder: boolean;
  near: number; frontPixels: number; rearPixels: number; otherPixels: number;
  /** The same pose with the nudge removed. */
  reference: { frontPixels: number; rearPixels: number; otherPixels: number };
}
export interface CoplanarRow {
  mesh: Mesh; samples: number; distance: number; delta: number; angle: number; reverseDrawOrder: boolean;
  /** Nudge levels between the two entities; 0 leaves them to draw order and depth noise. */
  levelDelta: number;
  /** Pixels of the higher-hash entity, of the lower, of neither. */
  frontPixels: number; rearPixels: number; otherPixels: number;
}
/**
 * One crease pose at 4x MSAA over the whole target. `mixedPixels` resolved to
 * a blend of both faces; `differingPixels` differ from the fixed-function
 * reference by an RGB sum over 30.
 */
export interface CreaseRow {
  variant: typeof CREASE_VARIANTS[number]; distance: number; reverseDrawOrder: boolean;
  mixedPixels: number; differingPixels: number;
  /** Production vertex stage without the nudge, fixed-function depth: the geometric crease. */
  reference: { mixedPixels: number };
}
/** The shader's own displacement of the highest hash, read back from depth32float at the probe centre. */
export interface ShiftRow {
  distance: number; angle: number; target: Target;
  /** View depth of the probe centre, unnudged and nudged, in metres. */
  depth: number; nudgedDepth: number; shift: number;
}
export interface PerspectiveDistanceReport {
  adapter: { vendor: string; architecture: string; description: string };
  depthFormat: string; separated: SeparatedRow[]; coplanar: CoplanarRow[]; shifts: ShiftRow[]; creases: CreaseRow[]; errors: string[];
}

function camera(distance: number, angle: number, target: Target) {
  const theta = angle * Math.PI / 180;
  const eye = { x: distance * Math.sin(theta), y: 0, z: distance * Math.cos(theta) };
  const cam = new Camera();
  cam.setAspect(1); cam.setFOV(FOV);
  // Near-camera: the orbit target 5 m ahead along the view, as walk mode,
  // fast zoom and a pan after a close zoom leave it.
  const ahead = target === 'near-camera' ? 5 / distance : 1;
  cam.setTarget(eye.x * (1 - ahead), 0, eye.z * (1 - ahead));
  cam.setPosition(eye.x, eye.y, eye.z);
  return cam;
}

/**
 * `depthFormat` defaults to the production pipeline's; `nudge` replaces
 * `depthNudgeWgsl` (production when omitted). The separated reference always
 * uses `ZERO_NUDGE`.
 */
export async function runPerspectiveDistanceWitness(
  depthFormat: GPUTextureFormat = PIPELINE_CONSTANTS.DEPTH_FORMAT, nudge?: string,
): Promise<PerspectiveDistanceReport> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('WebGPU adapter unavailable; no perspective witness ran');
  const requiredFeatures: GPUFeatureName[] = depthFormat === 'depth32float-stencil8' ? ['depth32float-stencil8'] : [];
  const device = await adapter.requestDevice({ requiredFeatures });
  const errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
  const owned: GPUBuffer[] = [];
  const buffer = (data: ArrayBufferView, usage: GPUBufferUsageFlags) => {
    const result = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(result, 0, data.buffer, data.byteOffset, data.byteLength);
    owned.push(result); return result;
  };
  const source = (override: string | undefined, frontId: number) => {
    const base = override === undefined ? mainShaderSource : mainShaderSource.replace(depthNudgeWgsl, override);
    if (override !== undefined && base === mainShaderSource) throw new Error('Nudge override did not apply');
    return base + `
      fn witnessColor(input: VertexOutput) -> vec4<f32> {
        let front = (input.entityId & 0x00ffffffu) == ${frontId}u;
        return select(vec4<f32>(0,1,0,1), vec4<f32>(1,0,0,1), front);
      }
      // The production depth is fixed-function; only the colour is an ID.
      @fragment fn fs_witness(input: VertexOutput) -> @location(0) vec4<f32> { return witnessColor(input); }
      // Crease control: the same depth, written once per pixel for all its samples.
      struct PixelDepthOut { @location(0) color: vec4<f32>, @builtin(frag_depth) depth: f32 }
      @fragment fn fs_pixel_depth(input: VertexOutput) -> PixelDepthOut { return PixelDepthOut(witnessColor(input), input.position.z); }`;
  };
  /** 4x MSAA crease pipelines: production, its one-depth-per-pixel control, and the zero-nudge reference. */
  const creasePipeline = async (variant: CreaseRow['variant'] | 'reference', frontId: number) => {
    const shader = device.createShaderModule({ code: source(variant === 'reference' ? ZERO_NUDGE : nudge, frontId) });
    return device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module: shader, entryPoint: 'vs_main', buffers: [LAYOUT] },
      fragment: { module: shader, entryPoint: variant === 'pixel-centre' ? 'fs_pixel_depth' : 'fs_witness', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: 4 },
    });
  };
  const pipelines = new Map<string, GPURenderPipeline>();
  const pipeline = async (override: string | undefined, frontId: number, samples: number) => {
    const key = `${override ?? 'production'}|${frontId}|${samples}`;
    let found = pipelines.get(key);
    if (!found) {
      const shader = device.createShaderModule({ code: source(override, frontId) });
      found = await device.createRenderPipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module: shader, entryPoint: 'vs_main', buffers: [LAYOUT] },
        fragment: { module: shader, entryPoint: 'fs_witness', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'greater' },
        multisample: { count: samples },
      });
      pipelines.set(key, found);
    }
    return found;
  };
  /** Depth only, into depth32float, so the read-back value is the shader's own arithmetic. */
  const depthPipeline = async (override: string | undefined) => {
    const shader = device.createShaderModule({ code: source(override, 0) });
    return device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module: shader, entryPoint: 'vs_main', buffers: [LAYOUT] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
  };
  const indices: Record<Mesh, Uint32Array[]> = { fine: [gridIndices(false, GRID), gridIndices(true, GRID)], coarse: [gridIndices(false, 1), gridIndices(true, 1)] };
  const indexBuffers = { fine: indices.fine.map(i => buffer(i, GPUBufferUsage.INDEX)), coarse: indices.coarse.map(i => buffer(i, GPUBufferUsage.INDEX)) };
  /** Front entity first: square at z (front) and at 0 (rear), each `2 * distance` wide. */
  const pieces = (cam: Camera, distance: number, front: { lane: number }, rear: { lane: number }, frontZ: number, mesh: Mesh = 'fine'): Piece[] => {
    const n = cells(mesh);
    const vp = MathUtils.multiply({ m: Float32Array.from([ZOOM, 0, 0, 0, 0, ZOOM, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }, cam.getViewProjMatrix());
    return [front, rear].map((entity, i) => {
      const z = i === 0 ? frontZ : 0, h = distance, count = (n + 1) ** 2;
      const packed = new Float32Array(7 * count), lanes = new Uint32Array(packed.buffer);
      for (let j = 0; j <= n; j++) for (let k = 0; k <= n; k++) {
        const v = j * (n + 1) + k;
        packed.set([-h + 2 * h * k / n, -h + 2 * h * j / n, z], v * 7); packed[v * 7 + 5] = 1; lanes[v * 7 + 6] = entity.lane;
      }
      const uniform = new Float32Array(MESH_UNIFORM_FLOATS);
      uniform.set(vp.m); uniform.set(MathUtils.identity().m, MESH_UNIFORM_OFFSET.model);
      uniform.set(COLOR, MESH_UNIFORM_OFFSET.baseColor);
      return {
        vertex: buffer(packed, GPUBufferUsage.VERTEX), index: indexBuffers[mesh][i]!, count: indices[mesh][i]!.length,
        bindGroup: device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: buffer(uniform, GPUBufferUsage.UNIFORM) } }] }),
      };
    });
  };
  /**
   * Crease: a face at z = 0 (front entity) and one through it at 45 degrees,
   * z = x - 0.37 y, so they cross along a slanted line through the view.
   */
  const creasePieces = (cam: Camera, distance: number, front: { lane: number }, rear: { lane: number }): Piece[] => {
    const n = GRID, h = distance, count = (n + 1) ** 2;
    const vp = MathUtils.multiply({ m: Float32Array.from([ZOOM, 0, 0, 0, 0, ZOOM, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }, cam.getViewProjMatrix());
    return [front, rear].map((entity, i) => {
      const packed = new Float32Array(7 * count), lanes = new Uint32Array(packed.buffer);
      for (let j = 0; j <= n; j++) for (let k = 0; k <= n; k++) {
        const v = j * (n + 1) + k, x = -h + 2 * h * k / n, y = -h + 2 * h * j / n;
        packed.set([x, y, i === 0 ? 0 : x - 0.37 * y], v * 7); packed[v * 7 + 5] = 1; lanes[v * 7 + 6] = entity.lane;
      }
      const uniform = new Float32Array(MESH_UNIFORM_FLOATS);
      uniform.set(vp.m); uniform.set(MathUtils.identity().m, MESH_UNIFORM_OFFSET.model);
      uniform.set(COLOR, MESH_UNIFORM_OFFSET.baseColor);
      return {
        vertex: buffer(packed, GPUBufferUsage.VERTEX), index: indexBuffers.fine[i]!, count: indices.fine[i]!.length,
        bindGroup: device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: buffer(uniform, GPUBufferUsage.UNIFORM) } }] }),
      };
    });
  };
  const separated: SeparatedRow[] = [];
  const coplanar: CoplanarRow[] = [];
  try {
    const panel = entityForHash(0), wall = entityForHash(255);
    for (const samples of [1, 4]) {
      const production = await pipeline(nudge, panel.id, samples), reference = await pipeline(ZERO_NUDGE, panel.id, samples);
      for (const distance of DISTANCES) for (const gap of GAPS) for (const angle of ANGLES)
        for (const target of TARGETS) for (const reverseDrawOrder of [false, true]) {
          const mark = owned.length;
          try {
            const cam = camera(distance, angle, target);
            const drawn = pieces(cam, distance, panel, wall, gap);
            const ordered = reverseDrawOrder ? [...drawn].reverse() : drawn;
            const counts = await drawReadback(device, depthFormat, production, ordered, samples);
            const ref = await drawReadback(device, depthFormat, reference, ordered, samples);
            separated.push({ samples, distance, gap, angle, target, reverseDrawOrder, near: cam.getProjMatrix().m[14], ...counts, reference: ref });
          } finally { for (const b of owned.splice(mark)) b.destroy(); }
        }
    }
    const top = entityForHash(255);
    const shifts: ShiftRow[] = [];
    {
      const [nudged, unbiased] = [await depthPipeline(nudge), await depthPipeline(ZERO_NUDGE)];
      for (const distance of SHIFT_DISTANCES) for (const angle of [0, 70]) for (const target of TARGETS) {
        const mark = owned.length;
        try {
          const cam = camera(distance, angle, target);
          const near = cam.getProjMatrix().m[14];
          const [square] = pieces(cam, distance, top, top, 0);
          const [a, b] = [await readCentreDepth(device, unbiased, square), await readCentreDepth(device, nudged, square)];
          // Reverse-Z infinite far: NDC depth is near / view depth.
          const depth = near / a, nudgedDepth = near / b;
          shifts.push({ distance, angle, target, depth, nudgedDepth, shift: depth - nudgedDepth });
        } finally { for (const b of owned.splice(mark)) b.destroy(); }
      }
    }
    for (const mesh of ['fine', 'coarse'] as const) for (const delta of COPLANAR_DELTAS) {
      const lower = entityForHash(255 - delta);
      for (const samples of [1, 4]) {
        const production = await pipeline(nudge, top.id, samples);
        for (const distance of COPLANAR_DISTANCES) for (const angle of ANGLES) for (const reverseDrawOrder of [false, true]) {
          const mark = owned.length;
          try {
            const drawn = pieces(camera(distance, angle, 'on-facade'), distance, top, lower, 0, mesh);
            const counts = await drawReadback(device, depthFormat, production, reverseDrawOrder ? [...drawn].reverse() : drawn, samples);
            coplanar.push({ mesh, samples, distance, delta, angle, reverseDrawOrder, levelDelta: nudgeLevel(255) - nudgeLevel(255 - delta), ...counts });
          } finally { for (const b of owned.splice(mark)) b.destroy(); }
        }
      }
    }
    // Both faces get the highest hash, so the nudge scales both alike where
    // they cross and leaves the crease line where the geometry puts it.
    const creases: CreaseRow[] = [];
    {
      const creaseFront = top, creaseRear = entityForHash(255, top.id);
      const reference = await creasePipeline('reference', creaseFront.id);
      for (const variant of CREASE_VARIANTS) {
        const drawn = await creasePipeline(variant, creaseFront.id);
        for (const distance of CREASE_DISTANCES) for (const reverseDrawOrder of [false, true]) {
          const mark = owned.length;
          try {
            const pieces = creasePieces(camera(distance, 0, 'on-facade'), distance, creaseFront, creaseRear);
            const ordered = reverseDrawOrder ? [...pieces].reverse() : pieces;
            const [image, ref] = [await drawResolved(device, depthFormat, drawn, ordered, 4), await drawResolved(device, depthFormat, reference, ordered, 4)];
            let differingPixels = 0;
            for (let p = 0; p < SIZE * SIZE; p++) {
              const o = Math.floor(p / SIZE) * 256 + (p % SIZE) * 4;
              if (Math.abs(image[o]! - ref[o]!) + Math.abs(image[o + 1]! - ref[o + 1]!) + Math.abs(image[o + 2]! - ref[o + 2]!) > 30) differingPixels++;
            }
            creases.push({ variant, distance, reverseDrawOrder, mixedPixels: mixedPixels(image), differingPixels, reference: { mixedPixels: mixedPixels(ref) } });
          } finally { for (const b of owned.splice(mark)) b.destroy(); }
        }
      }
    }
    await device.queue.onSubmittedWorkDone();
    return { adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description },
      depthFormat, separated, coplanar, shifts, creases, errors };
  } finally { for (const b of owned) b.destroy(); device.destroy(); }
}

interface Piece { vertex: GPUBuffer; index: GPUBuffer; count: number; bindGroup: GPUBindGroup }
async function drawReadback(device: GPUDevice, depthFormat: GPUTextureFormat, pipeline: GPURenderPipeline, pieces: Piece[], samples: number) {
  const rgba = await drawResolved(device, depthFormat, pipeline, pieces, samples);
  let frontPixels = 0, rearPixels = 0, otherPixels = 0;
  for (let y = PROBE_MIN; y < PROBE_MAX; y++) for (let x = PROBE_MIN; x < PROBE_MAX; x++) {
    const offset = y * 256 + x * 4;
    if (rgba[offset] === 255 && rgba[offset + 1] === 0) frontPixels++;
    else if (rgba[offset + 1]! > 0) rearPixels++; // Includes one leaked MSAA sample after resolve.
    else otherPixels++;
  }
  return { frontPixels, rearPixels, otherPixels };
}

/** Pixels resolved to a blend of the red and green faces, neither pure. */
function mixedPixels(rgba: Uint8Array): number {
  let mixed = 0;
  for (let p = 0; p < SIZE * SIZE; p++) {
    const o = Math.floor(p / SIZE) * 256 + (p % SIZE) * 4;
    if (rgba[o]! > 0 && rgba[o + 1]! > 0) mixed++;
  }
  return mixed;
}

/** The resolved target, 256 bytes per row. */
async function drawResolved(device: GPUDevice, depthFormat: GPUTextureFormat, pipeline: GPURenderPipeline, pieces: Piece[], samples: number): Promise<Uint8Array> {
  const color = device.createTexture({ size: [SIZE, SIZE], sampleCount: samples, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | (samples === 1 ? GPUTextureUsage.COPY_SRC : 0) });
  const resolved = samples === 1 ? color : device.createTexture({ size: [SIZE, SIZE], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const depth = device.createTexture({ size: [SIZE, SIZE], sampleCount: samples, format: depthFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const read = device.createBuffer({ size: SIZE * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: color.createView(), ...(samples === 1 ? {} : { resolveTarget: resolved.createView() }), loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0,
        stencilLoadOp: 'clear', stencilStoreOp: 'store', stencilClearValue: 0 },
    });
    pass.setPipeline(pipeline);
    for (const piece of pieces) {
      pass.setBindGroup(0, piece.bindGroup); pass.setVertexBuffer(0, piece.vertex); pass.setIndexBuffer(piece.index, 'uint32'); pass.drawIndexed(piece.count);
    }
    pass.end(); encoder.copyTextureToBuffer({ texture: resolved }, { buffer: read, bytesPerRow: 256 }, [SIZE, SIZE]);
    device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
    const rgba = new Uint8Array(read.getMappedRange()).slice();
    read.unmap(); return rgba;
  } finally { read.destroy(); depth.destroy(); if (resolved !== color) resolved.destroy(); color.destroy(); }
}

async function readCentreDepth(device: GPUDevice, pipeline: GPURenderPipeline, piece: Piece): Promise<number> {
  const depth = device.createTexture({ size: [SIZE, SIZE], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const read = device.createBuffer({ size: SIZE * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 } });
    pass.setPipeline(pipeline); pass.setBindGroup(0, piece.bindGroup); pass.setVertexBuffer(0, piece.vertex);
    pass.setIndexBuffer(piece.index, 'uint32'); pass.drawIndexed(piece.count); pass.end();
    encoder.copyTextureToBuffer({ texture: depth, aspect: 'depth-only' }, { buffer: read, bytesPerRow: 256 }, [SIZE, SIZE]);
    device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
    const value = new Float32Array(read.getMappedRange())[(SIZE / 2) * 64 + SIZE / 2];
    read.unmap(); return value;
  } finally { read.destroy(); depth.destroy(); }
}
