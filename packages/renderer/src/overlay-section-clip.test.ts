/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { clipHalfSpaces } from './clip-half-spaces.js';
import { CAP_CLIP_FLOATS, MAX_CAP_CLIP_PLANES, MAX_EXTRA_CLIP_PLANES } from './extra-clip-planes.js';
import { pointClipped } from './scene-raycaster.js';
import { Section2DOverlayRenderer } from './section-2d-overlay.js';
import { RendererOverlays, type OverlayHost } from './renderer-overlays.js';
import { LINE_OVERLAY_CHANNELS, type LineOverlayChannel } from './section-2d-types.js';
import { SymbolicFillPipeline, SymbolicTextPipeline, type SymbolicFillInput } from './symbolic-overlay-pipelines.js';
import { SYMBOLIC_FILL_WGSL } from './shaders/symbolic-overlay.wgsl.js';
import type { SymbolicTextAtlas } from './symbolic-text-atlas.js';
import type { PickClipState } from './pick-types.js';
import type { ExtraClipPlane } from './clip-types.js';

/**
 * IfcAnnotation overlays clip like the model (#8767). Lines, fills and labels used to draw straight
 * across an active section plane or clip box; they now lose what the model's fragments lose, while
 * the grid and the other reference layers keep drawing whole.
 *
 * The oracle throughout is `pointClipped`, the CPU mirror the picker already trusts for the mesh
 * clip: a plane list the shaders read must agree with it at every point.
 *
 * Only exports that exist on main are imported, so reverting the production change fails these
 * tests on their assertions instead of at import (the revert oracle, scripts/check-test-revert-oracle.mjs).
 */

/** A fill partition's uniform: the 160-byte camera, then one overlay clip block. */
const FILL_UNIFORM_FLOATS = 40 + CAP_CLIP_FLOATS;

/** The model clip as a plane list, built from the half-spaces snapping already uses: test input only. */
function planesFor(clip: PickClipState): ExtraClipPlane[] {
  return clipHalfSpaces(clip).map(({ n, limit }) => ({ normal: [n[0], n[1], n[2]], distance: limit, flipped: false }));
}

(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUColorWrite = { ALL: 15 };
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};
(globalThis as Record<string, unknown>).GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 8, RENDER_ATTACHMENT: 16 };

/** CPU copy of the WGSL `extraClipClipped` over a decoded block: count, flipped mask, planes. */
function blockClips(block: Float32Array, offset: number, p: readonly [number, number, number]): boolean {
  const u32 = new Uint32Array(block.buffer, block.byteOffset, block.length);
  const count = u32[offset];
  const flipped = u32[offset + 1];
  for (let i = 0; i < count; i++) {
    const b = offset + 4 + i * 4;
    const side = (flipped >> i) & 1 ? -1 : 1;
    if ((p[0] * block[b] + p[1] * block[b + 1] + p[2] * block[b + 2] - block[b + 3]) * side > 0) return true;
  }
  return false;
}

function planesClip(planes: readonly ExtraClipPlane[], p: readonly [number, number, number]): boolean {
  return planes.some((pl) => (p[0] * pl.normal[0] + p[1] * pl.normal[1] + p[2] * pl.normal[2] - pl.distance) * (pl.flipped ? -1 : 1) > 0);
}

/** Deterministic points spread over [-10, 10]³. */
function samplePoints(n: number): Array<[number, number, number]> {
  let seed = 8767;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed / 2147483648) * 20 - 10; };
  return Array.from({ length: n }, () => [next(), next(), next()] as [number, number, number]);
}

const CUT_DOWN: PickClipState = { sectionPlane: { normal: [0, 1, 0], distance: 3, flipped: false } };
const EVERYTHING: PickClipState = {
  sectionPlane: { normal: [0, 1, 0], distance: 3, flipped: true },
  extraPlanes: [
    { normal: [1, 0, 0], distance: 4, flipped: false },
    { normal: [0.6, 0, 0.8], distance: -1, flipped: true },
  ],
  clipBox: { enabled: true, min: [-8, -6, -7], max: [7, 9, 6] },
};

// ─── Lines ────────────────────────────────────────────────────────────────────

function makeLineDevice() {
  const writes: Array<{ buffer: GPUBuffer; offset: number; data: Float32Array }> = [];
  const buffers: Array<{ size: number }> = [];
  const device = {
    limits: { minUniformBufferOffsetAlignment: 256 } as unknown as GPUSupportedLimits,
    createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
    createPipelineLayout: (desc: unknown) => ({ desc }) as unknown as GPUPipelineLayout,
    createShaderModule: (desc: { code: string }) => ({ code: desc.code }) as unknown as GPUShaderModule,
    createRenderPipeline: (desc: GPURenderPipelineDescriptor) => ({ desc }) as unknown as GPURenderPipeline,
    createBindGroup: (desc: unknown) => ({ desc }) as unknown as GPUBindGroup,
    createBuffer: (desc: { size: number }) => {
      const buf = { size: desc.size, destroy() {} };
      buffers.push(buf);
      return buf as unknown as GPUBuffer;
    },
    queue: {
      writeBuffer: (buffer: GPUBuffer, offset: number, data: ArrayBufferView) => {
        writes.push({ buffer, offset, data: new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) });
      },
    },
  } as unknown as GPUDevice;
  return { device, writes, buffers };
}

function makeLinePass() {
  const pipelines: string[] = [];
  const groupOne: number[] = [];
  const pass = {
    setPipeline: (p: GPURenderPipeline) => {
      const code = (p as unknown as { desc: GPURenderPipelineDescriptor }).desc.vertex.module as unknown as { code: string };
      pipelines.push(code.code.includes('extraClipClipped') ? 'clipped' : 'plain');
    },
    setBindGroup: (index: number, _g: GPUBindGroup, offsets?: number[]) => { if (index === 1) groupOne.push(offsets?.[0] ?? -1); },
    setVertexBuffer: () => {},
    draw: () => {},
  } as unknown as GPURenderPassEncoder;
  return { pass, pipelines, groupOne };
}

const TWO_SEGMENTS = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);

describe('Section2DOverlayRenderer: a section-clipped line channel (#8767)', () => {
  it('draws the plain line pipeline and binds no clip when no plane is given', () => {
    const { device } = makeLineDevice();
    const r = new Section2DOverlayRenderer(device, 'bgra8unorm' as GPUTextureFormat, 4);
    r.setLineOverlay('annotation', TWO_SEGMENTS);
    const { pass, pipelines, groupOne } = makeLinePass();
    r.drawLineOverlay(pass, new Float32Array(16), 'annotation', undefined, undefined, []);
    assert.deepStrictEqual(pipelines, ['plain']);
    assert.deepStrictEqual(groupOne, []);
  });

  it('draws the clipped pipeline with the world block for a legacy partition', () => {
    const { device, writes } = makeLineDevice();
    const r = new Section2DOverlayRenderer(device, 'bgra8unorm' as GPUTextureFormat, 4);
    r.setLineOverlay('annotation', TWO_SEGMENTS);
    const planes = planesFor(EVERYTHING);
    const { pass, pipelines, groupOne } = makeLinePass();
    r.drawLineOverlay(pass, new Float32Array(16), 'annotation', undefined, undefined, planes);
    assert.deepStrictEqual(pipelines, ['clipped']);
    assert.strictEqual(groupOne.length, 1);
    const block = writes.find((w) => w.offset === groupOne[0] && w.data.length === CAP_CLIP_FLOATS);
    assert.ok(block, 'the bound slot holds a freshly packed clip block');
    for (const p of samplePoints(500)) {
      assert.strictEqual(blockClips(block.data, 0, p), pointClipped(EVERYTHING, p[0], p[1], p[2]), `at ${p.join(',')}`);
    }
  });

  it('binds the eye-relative block for an anchored partition, so far models clip at the same place', () => {
    const { device, writes } = makeLineDevice();
    const r = new Section2DOverlayRenderer(device, 'bgra8unorm' as GPUTextureFormat, 4);
    const eye: [number, number, number] = [5_000_000.25, 20, -4];
    r.setLineOverlay('annotation', { localVertices: TWO_SEGMENTS, origin: [5_000_000, 0, 0] });
    const clip: PickClipState = { sectionPlane: { normal: [1, 0, 0], distance: 5_000_001.5, flipped: false } };
    const { pass, pipelines, groupOne } = makeLinePass();
    r.drawLineOverlay(pass, new Float32Array(16), 'annotation', new Float32Array(16), eye, planesFor(clip));
    assert.deepStrictEqual(pipelines, ['clipped']);
    assert.strictEqual(groupOne.length, 1);
    const block = writes.filter((w) => w.offset === groupOne[0] && w.data.length === CAP_CLIP_FLOATS).at(-1);
    assert.ok(block);
    // The shader compares eye-relative positions (world - eye) against this block.
    for (const worldX of [5_000_001.4, 5_000_001.6]) {
      const eyeRelative: [number, number, number] = [worldX - eye[0], 0 - eye[1], 0 - eye[2]];
      assert.strictEqual(blockClips(block.data, 0, eyeRelative), pointClipped(clip, worldX, 0, 0), `x=${worldX}`);
    }
  });

  it('never clips the centreline, whose directrix draws through its own solid', () => {
    const { device } = makeLineDevice();
    const r = new Section2DOverlayRenderer(device, 'bgra8unorm' as GPUTextureFormat, 4);
    r.setLineOverlay('centreline', TWO_SEGMENTS);
    const { pass, groupOne } = makeLinePass();
    r.drawLineOverlay(pass, new Float32Array(16), 'centreline', undefined, undefined, planesFor(CUT_DOWN));
    assert.deepStrictEqual(groupOne, []);
  });

  it('binds each partition of one channel to its own frame: anchored to the eye block, legacy to the world block', () => {
    const { device, writes } = makeLineDevice();
    const r = new Section2DOverlayRenderer(device, 'bgra8unorm' as GPUTextureFormat, 4);
    const eye: [number, number, number] = [5_000_000.25, 20, -4];
    // An anchored partition far from the origin and a legacy world-f32 one near it, in one upload.
    r.setLineOverlay('annotation', [
      { localVertices: TWO_SEGMENTS, origin: [5_000_000, 0, 0] },
      { localVertices: TWO_SEGMENTS, origin: null } as never,
    ]);
    const clip: PickClipState = { sectionPlane: { normal: [1, 0, 0], distance: 1.5, flipped: false } };
    const { pass, groupOne } = makeLinePass();
    r.drawLineOverlay(pass, new Float32Array(16), 'annotation', new Float32Array(16), eye, planesFor(clip));
    assert.strictEqual(groupOne.length, 2, 'both partitions draw clipped');
    assert.notStrictEqual(groupOne[0], groupOne[1], 'each binds its own frame\'s block');
    const block = (offset: number) => writes.filter((w) => w.offset === offset && w.data.length === CAP_CLIP_FLOATS).at(-1)!.data;
    const [eyeBlock, worldBlock] = groupOne.map(block);
    // Both cut at world x = 1.5: the eye block in eye-relative coordinates, the world block in world
    // ones. The probes sit 100 m either side: 5,000 km from the eye, f32 resolves 0.5 m, not 0.1 m.
    for (const worldX of [-100, 100]) {
      const clipped = pointClipped(clip, worldX, 0, 0);
      assert.strictEqual(blockClips(eyeBlock, 0, [worldX - eye[0], -eye[1], -eye[2]]), clipped, `eye x=${worldX}`);
      assert.strictEqual(blockClips(worldBlock, 0, [worldX, 0, 0]), clipped, `world x=${worldX}`);
    }
  });

  it('packs a full block (the cut, seven extras and the six box faces) without dropping a plane', () => {
    const { device, writes } = makeLineDevice();
    const r = new Section2DOverlayRenderer(device, 'bgra8unorm' as GPUTextureFormat, 4);
    r.setLineOverlay('annotation', TWO_SEGMENTS);
    const full: PickClipState = {
      ...EVERYTHING,
      extraPlanes: Array.from({ length: MAX_EXTRA_CLIP_PLANES }, (_, i) => {
        const a = (i / MAX_EXTRA_CLIP_PLANES) * Math.PI * 2;
        return { normal: [Math.cos(a), 0, Math.sin(a)] as [number, number, number], distance: 6, flipped: i % 2 === 1 };
      }),
    };
    const planes = planesFor(full);
    assert.strictEqual(planes.length, MAX_CAP_CLIP_PLANES);
    const { pass, groupOne } = makeLinePass();
    r.drawLineOverlay(pass, new Float32Array(16), 'annotation', undefined, undefined, planes);
    const block = writes.filter((w) => w.offset === groupOne[0] && w.data.length === CAP_CLIP_FLOATS).at(-1)!.data;
    assert.strictEqual(new Uint32Array(block.buffer)[0], MAX_CAP_CLIP_PLANES);
    for (const p of samplePoints(2000)) {
      assert.strictEqual(blockClips(block, 0, p), pointClipped(full, p[0], p[1], p[2]), `at ${p.join(',')}`);
    }
  });

  it('keeps its clip slots clear of every cap\'s, so a cap and the annotations clip independently in one frame', () => {
    const { device, writes } = makeLineDevice();
    const r = new Section2DOverlayRenderer(device, 'bgra8unorm' as GPUTextureFormat, 4);
    r.setLineOverlay('annotation', TWO_SEGMENTS);
    const triangle = [{ polygon: { outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], holes: [] }, ifcType: 'IfcWall', expressId: 1 }];
    r.uploadDrawing(triangle, [], 'down', 3);
    const { pass, groupOne } = makeLinePass();
    const options = { axis: 'down' as const, position: 50, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, viewProj: new Float32Array(16), showOutlines: true };
    r.draw(pass, options, []);
    const capSlot = groupOne.at(-1)!;
    r.drawLineOverlay(pass, new Float32Array(16), 'annotation', undefined, undefined, planesFor(CUT_DOWN));
    const annotationSlot = groupOne.at(-1)!;
    assert.notStrictEqual(annotationSlot, capSlot);
    const capBlock = writes.filter((w) => w.offset === capSlot && w.data.length === CAP_CLIP_FLOATS).at(-1)!.data;
    assert.strictEqual(new Uint32Array(capBlock.buffer)[0], 0, 'the primary cap is clipped by no other plane, and stays so');
  });
});

type Upload = (overlays: RendererOverlays) => void;
/** The viewer's uploads: every channel set, only the IfcAnnotation lines opting in to the clip. */
const VIEWER_UPLOADS: Upload = (overlays) => {
  for (const channel of LINE_OVERLAY_CHANNELS) overlays.setLineOverlay(channel, TWO_SEGMENTS, { sectionClipped: channel === 'annotation' });
};

/** Upload through `RendererOverlays`, draw one frame and report the planes each line channel was handed. */
function planesHandedOut(clip: PickClipState | null, upload: Upload = VIEWER_UPLOADS): Map<LineOverlayChannel, readonly ExtraClipPlane[]> {
  const host: OverlayHost = {
    getModelBounds: () => null,
    expandModelBoundsWithFlatVertices: () => {},
    expandModelBoundsWithAnchoredLineVertices: () => {},
    syncCameraSceneBounds: () => {},
    requestRender: () => {},
  };
  const overlays = new RendererOverlays(host);
  const received = new Map<LineOverlayChannel, readonly ExtraClipPlane[]>();
  (overlays as unknown as Record<string, unknown>)['section2DOverlayRenderer'] = {
    setCapHighlight: () => {},
    hasGeometry: () => false,
    hasExtraGeometry: () => false,
    hasLineOverlay: () => true,
    hasClashBoxLines3D: () => false,
    setLineOverlay: () => {},
    drawLineOverlay: (_p: unknown, _vp: unknown, channel: LineOverlayChannel, _r: unknown, _c: unknown, planes?: readonly ExtraClipPlane[]) => {
      received.set(channel, planes ?? []);
    },
  };
  upload(overlays);
  overlays.draw({} as GPURenderPassEncoder, {
    options: {} as never,
    viewProj: new Float32Array(16),
    modelBounds: null,
    camera: { getPosition: () => ({ x: 0, y: 0, z: 1 }), getTarget: () => ({ x: 0, y: 0, z: 0 }), getUp: () => ({ x: 0, y: 1, z: 0 }) } as never,
    canvasWidth: 1, canvasHeight: 1,
    clip,
  } as Parameters<RendererOverlays['draw']>[1]);
  return received;
}

describe('RendererOverlays: the model clip reaches only a channel that opted in (#8767)', () => {
  it('hands the opted-in annotation channel the frame\'s planes and every other channel none', () => {
    const received = planesHandedOut(CUT_DOWN);
    for (const channel of LINE_OVERLAY_CHANNELS) {
      assert.strictEqual(received.get(channel)?.length ?? 0, channel === 'annotation' ? 1 : 0, channel);
    }
  });

  it('clips no channel that did not opt in, the default for every existing caller', () => {
    const received = planesHandedOut(CUT_DOWN, (overlays) => {
      for (const channel of LINE_OVERLAY_CHANNELS) overlays.setLineOverlay(channel, TWO_SEGMENTS);
    });
    for (const channel of LINE_OVERLAY_CHANNELS) assert.strictEqual(received.get(channel)?.length ?? 0, 0, channel);
  });

  it('ties the opt-in to the upload: a later upload without it, or a clear, draws unclipped again', () => {
    const reuploaded = planesHandedOut(CUT_DOWN, (overlays) => {
      overlays.setLineOverlay('annotation', TWO_SEGMENTS, { sectionClipped: true });
      overlays.setLineOverlay('annotation', TWO_SEGMENTS);
    });
    assert.strictEqual(reuploaded.get('annotation')?.length ?? 0, 0);
    const cleared = planesHandedOut(CUT_DOWN, (overlays) => {
      overlays.setLineOverlay('annotation', TWO_SEGMENTS, { sectionClipped: true });
      overlays.setLineOverlay('annotation', null, { sectionClipped: true });
    });
    assert.strictEqual(cleared.get('annotation')?.length ?? 0, 0);
  });

  it('hands no plane when nothing clips, so an unclipped frame packs no block', () => {
    assert.strictEqual(planesHandedOut(null).get('annotation')?.length ?? 0, 0);
    assert.strictEqual(planesHandedOut({}).get('annotation')?.length ?? 0, 0);
    assert.strictEqual(planesHandedOut({ clipBox: { enabled: false, min: [0, 0, 0], max: [1, 1, 1] } }).get('annotation')?.length ?? 0, 0);
  });

  for (const [name, clip] of [['a plain cut', CUT_DOWN], ['a flipped cut, two extras and a box', EVERYTHING]] as const) {
    it(`hands planes that agree with pointClipped at every sample point: ${name}`, () => {
      const planes = planesHandedOut(clip).get('annotation') ?? [];
      assert.ok(planes.length > 0);
      for (const p of samplePoints(2000)) {
        assert.strictEqual(planesClip(planes, p), pointClipped(clip, p[0], p[1], p[2]), `at ${p.join(',')}`);
      }
    });
  }

  it('drops the extras past the mesh block capacity, as the mesh does, and keeps the box', () => {
    const extras = Array.from({ length: MAX_EXTRA_CLIP_PLANES + 2 }, (_, i) => (
      { normal: [1, 0, 0] as [number, number, number], distance: 9 - i, flipped: false }));
    const clip: PickClipState = { ...EVERYTHING, extraPlanes: extras };
    const planes = planesHandedOut(clip).get('annotation') ?? [];
    assert.strictEqual(planes.length, 1 + MAX_EXTRA_CLIP_PLANES + 6);
    assert.ok(planes.length <= MAX_CAP_CLIP_PLANES, 'every plane fits one overlay block');
    for (const p of samplePoints(2000)) {
      assert.strictEqual(planesClip(planes, p), pointClipped(clip, p[0], p[1], p[2]), `at ${p.join(',')}`);
    }
  });
});

// ─── Fills ────────────────────────────────────────────────────────────────────

function makeFillDevice() {
  const uniformSizes: number[] = [];
  const layouts: GPUBindGroupLayoutDescriptor[] = [];
  const writes: Array<{ buffer: GPUBuffer; data: Float32Array }> = [];
  const shaders: string[] = [];
  const device = {
    createBindGroupLayout: (desc: GPUBindGroupLayoutDescriptor) => { layouts.push(desc); return {} as GPUBindGroupLayout; },
    createPipelineLayout: () => ({}) as GPUPipelineLayout,
    createShaderModule: (desc: { code: string }) => { shaders.push(desc.code); return {} as GPUShaderModule; },
    createRenderPipeline: () => ({}) as GPURenderPipeline,
    createBindGroup: () => ({}) as GPUBindGroup,
    createBuffer: (desc: { size: number; usage: number }) => {
      if (desc.usage & 64) uniformSizes.push(desc.size);
      return { destroy() {} } as unknown as GPUBuffer;
    },
    queue: {
      writeBuffer: (buffer: GPUBuffer, _offset: number, data: ArrayBufferView) => {
        writes.push({ buffer, data: new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) });
      },
    },
  } as unknown as GPUDevice;
  return { device, uniformSizes, layouts, writes, shaders };
}

const SQUARE = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
function fill(over: Partial<SymbolicFillInput>): SymbolicFillInput {
  return { points: SQUARE, holesOffsets: new Uint32Array(0), worldY: 0, color: [1, 0, 0, 1], ...over };
}

/** The camera uniforms one fill render wrote, in draw order. */
function fillUniforms(writes: Array<{ data: Float32Array }>): Float32Array[] {
  return writes.filter((w) => w.data.length === FILL_UNIFORM_FLOATS).map((w) => w.data);
}

describe('SymbolicFillPipeline: section-clipped fills (#8767)', () => {
  it('reads its clip block in the fragment stage, after the 160-byte camera', () => {
    const { device, uniformSizes, layouts, shaders } = makeFillDevice();
    const pipeline = new SymbolicFillPipeline(device, 'bgra8unorm', 4);
    pipeline.upload([fill({ sectionClipped: true })]);
    assert.deepStrictEqual(uniformSizes, [FILL_UNIFORM_FLOATS * 4]);
    const visibility = (layouts[0].entries as GPUBindGroupLayoutEntry[])[0].visibility;
    assert.ok(visibility & 2, 'the fragment stage can read the clip block');
    assert.strictEqual(shaders.length, 1);
    const code = shaders[0];
    assert.match(code, /originLow: vec4<f32>,\s*\/\/[^\n]*\n[^\n]*\n\s*clip: ExtraClip,/, 'the block follows the 160-byte camera');
    assert.match(code, /array<vec4<f32>, 14>/);
    assert.match(code, /if \(extraClipClipped\(camera\.clip, in\.clipSpacePos\)\) \{ discard; \}/);
  });

  it('leaves the shared unclipped fill shader exactly as the clash solid binds it: 160 bytes, vertex only', () => {
    // ClashSolidPipeline reuses SYMBOLIC_FILL_WGSL with a vertex-only 160-byte uniform. A clip read
    // there would fail validation on a real GPU (fragment access, binding too small).
    assert.doesNotMatch(SYMBOLIC_FILL_WGSL, /ExtraClip|extraClipClipped|clipSpacePos|discard/);
    assert.match(SYMBOLIC_FILL_WGSL, /originLow: vec4<f32>,\n\};/);
  });

  it('packs the planes for clipped partitions only; grid bubbles and other unflagged fills keep a zero count', () => {
    const { device, writes } = makeFillDevice();
    const pipeline = new SymbolicFillPipeline(device, 'bgra8unorm', 4);
    pipeline.upload([
      fill({ sectionClipped: true }),
      fill({ sectionClipped: false, definesExtent: false }),
      fill({}),
    ]);
    const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() {} } as unknown as GPURenderPassEncoder;
    const planes = planesFor(EVERYTHING);
    pipeline.render(pass, new Float32Array(16), undefined, undefined, planes);
    const uniforms = fillUniforms(writes);
    assert.strictEqual(uniforms.length, 2, 'legacy fills share one partition per clip mode');
    const counts = uniforms.map((u) => new Uint32Array(u.buffer)[40]).sort();
    assert.deepStrictEqual(counts, [0, planes.length]);
    const clipped = uniforms.find((u) => new Uint32Array(u.buffer)[40] > 0)!;
    for (const p of samplePoints(500)) {
      assert.strictEqual(blockClips(clipped, 40, p), pointClipped(EVERYTHING, p[0], p[1], p[2]), `at ${p.join(',')}`);
    }
  });

  it('packs an anchored partition\'s planes eye-relative, the frame its fragments compare in', () => {
    const { device, writes } = makeFillDevice();
    const pipeline = new SymbolicFillPipeline(device, 'bgra8unorm', 4);
    pipeline.upload([fill({ sectionClipped: true, origin: [5_000_000, 0, 0] })]);
    const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() {} } as unknown as GPURenderPassEncoder;
    const eye: [number, number, number] = [5_000_000.25, 20, -4];
    const clip: PickClipState = { sectionPlane: { normal: [1, 0, 0], distance: 5_000_000.5, flipped: false } };
    pipeline.render(pass, new Float32Array(16), new Float32Array(16), eye, planesFor(clip));
    const [u] = fillUniforms(writes);
    assert.strictEqual(u[35], 1, 'the partition draws on the RTE path');
    for (const worldX of [5_000_000.4, 5_000_000.6]) {
      assert.strictEqual(blockClips(u, 40, [worldX - eye[0], -eye[1], -eye[2]]), pointClipped(clip, worldX, 0, 0), `x=${worldX}`);
    }
  });

  it('clips nothing when the frame has no plane, even for a clipped fill', () => {
    const { device, writes } = makeFillDevice();
    const pipeline = new SymbolicFillPipeline(device, 'bgra8unorm', 4);
    pipeline.upload([fill({ sectionClipped: true })]);
    const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() {} } as unknown as GPURenderPassEncoder;
    pipeline.render(pass, new Float32Array(16));
    assert.strictEqual(new Uint32Array(fillUniforms(writes)[0].buffer)[40], 0);
  });
});

// ─── Labels ───────────────────────────────────────────────────────────────────

function makeAtlas(): SymbolicTextAtlas {
  return {
    atlasSize: 64,
    glyphPx: 48,
    canvas: {},
    getVersion: () => 1,
    layoutString: (content: string) => ({
      totalAdvancePx: 12 * content.length,
      glyphs: Array.from(content, (_, i) => ({
        xOffsetPx: 12 * i,
        glyph: { u0: 0, v0: 0, u1: 0.25, v1: 0.25, widthPx: 12, heightPx: 24, advancePx: 12, baselinePx: 18 },
      })),
    }),
  } as unknown as SymbolicTextAtlas;
}

function makeTextDevice(): GPUDevice {
  return {
    createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
    createPipelineLayout: () => ({}) as GPUPipelineLayout,
    createShaderModule: () => ({}) as GPUShaderModule,
    createRenderPipeline: () => ({}) as GPURenderPipeline,
    createBuffer: () => ({ destroy() {} }) as GPUBuffer,
    createSampler: () => ({}) as GPUSampler,
    createTexture: () => ({ createView: () => ({}) as GPUTextureView, destroy() {} }) as GPUTexture,
    createBindGroup: () => ({}) as GPUBindGroup,
    queue: { writeBuffer() {}, copyExternalImageToTexture() {} },
  } as unknown as GPUDevice;
}

describe('SymbolicTextPipeline: section-clipped labels (#8767)', () => {
  const label = (y: number, content: string, sectionClipped?: boolean) => ({
    origin: [0, y, 0] as [number, number, number], worldPos: [0, 0, 0] as [number, number, number],
    dirX: 1, dirZ: 0, height: 0.1, content, alignment: 'bottom-left' as const, sectionClipped,
  });

  function drawnInstances(pipeline: SymbolicTextPipeline, clip: PickClipState | null, camera?: [number, number, number]): number[] {
    const drawn: number[] = [];
    const pass = {
      setPipeline() {}, setBindGroup() {}, setVertexBuffer() {},
      draw(_v: number, count: number, _fv: number, first: number) { for (let i = 0; i < count; i++) drawn.push(first + i); },
    } as unknown as GPURenderPassEncoder;
    pipeline.render(pass, new Float32Array(16), 800, 600, [1, 0, 0], [0, 1, 0], 14,
      camera ? new Float32Array(16) : undefined, camera, clip);
    return drawn;
  }

  it('hides a whole clipped label above the cut and keeps the one below and an unflagged grid tag', () => {
    const pipeline = new SymbolicTextPipeline(makeTextDevice(), 'bgra8unorm', 1, makeAtlas());
    // Glyph instances: 0-1 "AB" below the cut, 2-4 "CDE" above it, 5 grid tag "1" above it.
    pipeline.upload([label(1, 'AB', true), label(5, 'CDE', true), label(5, '1', false)]);
    assert.deepStrictEqual(drawnInstances(pipeline, CUT_DOWN, [0, 0, 10]), [0, 1, 5]);
    assert.deepStrictEqual(drawnInstances(pipeline, CUT_DOWN), [0, 1, 5], 'the legacy projection hides it too');
  });

  it('draws every label without a clip, and again once the cut is gone', () => {
    const pipeline = new SymbolicTextPipeline(makeTextDevice(), 'bgra8unorm', 1, makeAtlas());
    pipeline.upload([label(1, 'AB', true), label(5, 'CDE', true)]);
    assert.deepStrictEqual(drawnInstances(pipeline, CUT_DOWN, [0, 0, 10]), [0, 1]);
    assert.deepStrictEqual(drawnInstances(pipeline, null, [0, 0, 10]), [0, 1, 2, 3, 4]);
  });

  it('follows a flipped cut and the clip box', () => {
    const pipeline = new SymbolicTextPipeline(makeTextDevice(), 'bgra8unorm', 1, makeAtlas());
    pipeline.upload([label(1, 'A', true), label(5, 'B', true), label(50, 'C', true)]);
    const flipped: PickClipState = { sectionPlane: { normal: [0, 1, 0], distance: 3, flipped: true } };
    assert.deepStrictEqual(drawnInstances(pipeline, flipped, [0, 0, 10]), [1, 2]);
    const box: PickClipState = { clipBox: { enabled: true, min: [-1, 0, -1], max: [1, 10, 1] } };
    assert.deepStrictEqual(drawnInstances(pipeline, box, [0, 0, 10]), [0, 1]);
  });
});
