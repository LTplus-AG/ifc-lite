/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Section2DOverlayRenderer } from './section-2d-overlay.js';
import { EXTRA_CLIP_FLOATS } from './extra-clip-planes.js';
import {
  SECTION_2D_CAP_FILL_WGSL,
  SECTION_2D_CAP_LINE_WGSL,
  SECTION_2D_MAX_EXTRA_CAPS,
  SECTION_2D_OVERLAY_LINE_WGSL,
  SECTION_2D_UNIFORM_FLOATS,
  SECTION_2D_UNIFORM_SLOT_INDEX,
} from './shaders/section-2d-overlay.wgsl.js';
import type { ExtraClipPlane } from './clip-types.js';

/**
 * One cap per cutting plane (#7545), drawn through the real `Section2DOverlayRenderer`
 * against a recording device: each cap gets a uniform slot of its own, and the block
 * of planes that clips it holds every OTHER plane and never its own.
 */

(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
};

interface Rec { buffer: { __id: number }; offset: number; data: Float32Array }

function newRenderer() {
  const writes: Rec[] = [];
  const created: Array<{ __id: number; __size: number; __destroyed: number; destroy(): void }> = [];
  const device = {
    limits: { minUniformBufferOffsetAlignment: 256 },
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createShaderModule: (d: { code: string }) => ({ code: d.code }),
    createRenderPipeline: () => ({}),
    createBindGroup: () => ({}),
    createBuffer: ({ size }: { size: number }) => {
      const b = { __id: created.length, __size: size, __destroyed: 0, destroy() { this.__destroyed++; } };
      created.push(b);
      return b;
    },
    queue: {
      writeBuffer: (buffer: { __id: number }, offset: number, data: ArrayBufferView) => {
        writes.push({ buffer, offset, data: new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) });
      },
    },
  } as unknown as GPUDevice;
  const renderer = new Section2DOverlayRenderer(device, 'rgba8unorm' as GPUTextureFormat, 4);
  return { renderer, writes, created };
}

function makePass() {
  const binds: Array<{ group: number; offset: number }> = [];
  const draws: string[] = [];
  const pass = {
    setPipeline() {}, setVertexBuffer() {}, setIndexBuffer() {},
    setBindGroup: (group: number, _g: unknown, offsets?: number[]) => { binds.push({ group, offset: offsets?.[0] ?? 0 }); },
    draw: (n: number) => draws.push(`draw:${n}`),
    drawIndexed: (n: number) => draws.push(`drawIndexed:${n}`),
  } as unknown as GPURenderPassEncoder;
  return { pass, binds, draws };
}

const TRIANGLE = [{ polygon: { outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], holes: [] }, ifcType: 'IfcWall', expressId: 1 }];
const STYLE = {
  fillColor: [1, 1, 1, 1] as [number, number, number, number], strokeColor: [0, 0, 0, 1] as [number, number, number, number],
  patternId: 1, spacingPx: 8, angleRad: 0, widthPx: 1, secondaryAngleRad: 0,
};
const OPTIONS = {
  axis: 'down' as const, position: 50, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  viewProj: new Float32Array(16), showFills: true, showOutlines: true, capStyle: STYLE,
};
const plane = (nx: number, ny: number, nz: number, distance: number, id?: string, flipped = false): ExtraClipPlane =>
  ({ normal: [nx, ny, nz], distance, flipped, ...(id ? { id } : {}) });

/** The clip block a write carries: its plane count and each plane's distance. */
function decodeClip(data: Float32Array): { count: number; mask: number; distances: number[]; normals: number[][] } {
  const meta = new Uint32Array(data.buffer, data.byteOffset, 2);
  const count = meta[0]!;
  return {
    count, mask: meta[1]!,
    distances: Array.from({ length: count }, (_, i) => data[4 + i * 4 + 3]!),
    normals: Array.from({ length: count }, (_, i) => [data[4 + i * 4]!, data[5 + i * 4]!, data[6 + i * 4]!]),
  };
}
const clipWrites = (writes: Rec[]) => writes.filter((w) => w.data.length === EXTRA_CLIP_FLOATS);
const uniformWrites = (writes: Rec[]) => writes.filter((w) => w.data.length === SECTION_2D_UNIFORM_FLOATS);

describe('a cap per cutting plane (#7545)', () => {
  it('draws the primary cap and each extra cap in its own uniform slot, each bound once for fill and outline', () => {
    const { renderer, writes } = newRenderer();
    renderer.uploadDrawing(TRIANGLE, [], 'down', 1);
    renderer.uploadExtraDrawing('b', TRIANGLE, [], 'side', 2);
    renderer.uploadExtraDrawing('c', TRIANGLE, [], 'front', 3);
    const { pass, binds, draws } = makePass();
    const b = plane(1, 0, 0, 2, 'b');
    const c = plane(0, 0, 1, 3, 'c');
    renderer.draw(pass, OPTIONS, [b, c]);
    renderer.drawExtras(pass, OPTIONS, [
      { key: 'b', clippedBy: [plane(0, 1, 0, 1), c] },
      { key: 'c', clippedBy: [plane(0, 1, 0, 1), b] },
    ]);

    const slots = uniformWrites(writes).map((w) => w.offset / 256);
    assert.deepEqual(slots, [
      SECTION_2D_UNIFORM_SLOT_INDEX.sectionCut,
      SECTION_2D_UNIFORM_SLOT_INDEX.extraCap,
      SECTION_2D_UNIFORM_SLOT_INDEX.extraCap + 1,
    ], 'one record per cap, the extras after every line range');
    // Fill + depth + outline per cap: the uniform group is bound for fill and outline, the clip group likewise.
    assert.equal(binds.filter((x) => x.group === 0).length, 6);
    assert.equal(binds.filter((x) => x.group === 1).length, 6);
    assert.ok(draws.length >= 9, 'every cap drew its fill, its depth pass and its outline');
  });

  it('clips each cap by every OTHER plane and never by its own', () => {
    const { renderer, writes } = newRenderer();
    renderer.uploadDrawing(TRIANGLE, [], 'down', 1);
    renderer.uploadExtraDrawing('b', TRIANGLE, [], 'side', 2);
    renderer.uploadExtraDrawing('c', TRIANGLE, [], 'front', 3);
    const { pass } = makePass();
    const primary = plane(0, 1, 0, 1);
    const b = plane(1, 0, 0, 2, 'b');
    const c = plane(0, 0, 1, 3, 'c', true);
    renderer.draw(pass, OPTIONS, [b, c]);
    renderer.drawExtras(pass, OPTIONS, [{ key: 'b', clippedBy: [primary, c] }, { key: 'c', clippedBy: [primary, b] }]);

    const [forPrimary, forB, forC] = clipWrites(writes).map((w) => decodeClip(w.data));
    assert.deepEqual(forPrimary!.distances, [2, 3], 'the primary cap is clipped by both extra planes');
    assert.deepEqual(forB!.distances, [1, 3], 'B is clipped by the primary and C, not by B');
    assert.deepEqual(forC!.distances, [1, 2], 'C is clipped by the primary and B, not by C');
    assert.equal(forB!.mask, 0b10, 'C is flipped and keeps that when it clips B');
    // Each cap has its own clip block (a dynamic-offset slot), so none overwrites another.
    assert.equal(new Set(clipWrites(writes).map((w) => w.offset)).size, 3);
  });

  it('keeps the primary cap\'s uniform record the last write of its draw, as before', () => {
    const { renderer, writes } = newRenderer();
    renderer.uploadDrawing(TRIANGLE, [], 'down', 1);
    const { pass } = makePass();
    renderer.draw(pass, OPTIONS);
    assert.equal(writes[writes.length - 1]!.data.length, SECTION_2D_UNIFORM_FLOATS);
    assert.equal(decodeClip(clipWrites(writes)[0]!.data).count, 0, 'one plane: nothing clips the cap');
  });

  it('draws nothing for an extra plane that has no cap, and a cleared one stops drawing', () => {
    const { renderer, writes } = newRenderer();
    renderer.uploadExtraDrawing('b', TRIANGLE, [], 'side', 2);
    const { pass, draws } = makePass();
    renderer.drawExtras(pass, OPTIONS, [{ key: 'missing', clippedBy: [] }]);
    assert.equal(draws.length, 0);
    assert.equal(uniformWrites(writes).length, 0);
    renderer.clearExtraGeometry(new Set());
    assert.equal(renderer.hasExtraGeometry(), false);
    renderer.drawExtras(pass, OPTIONS, [{ key: 'b', clippedBy: [] }]);
    assert.equal(draws.length, 0);
  });

  it('keeps the caps in `keep` and releases the rest, destroying their buffers', () => {
    const { renderer, created } = newRenderer();
    renderer.uploadExtraDrawing('b', TRIANGLE, [], 'side', 2);
    renderer.uploadExtraDrawing('c', TRIANGLE, [], 'front', 3);
    const owned = created.length;
    assert.deepEqual(renderer.extraGeometryKeys(), ['b', 'c']);
    renderer.clearExtraGeometry(new Set(['c']));
    assert.deepEqual(renderer.extraGeometryKeys(), ['c']);
    // `b` had a fill vertex + index buffer and an outline buffer; all three are gone.
    assert.ok(created.slice(0, owned).filter((buffer) => buffer.__destroyed === 1).length >= 2);
  });

  it('holds at most seven extra caps: an eighth has no slot and is ignored', () => {
    const { renderer } = newRenderer();
    for (let i = 0; i < SECTION_2D_MAX_EXTRA_CAPS + 3; i++) renderer.uploadExtraDrawing(`p${i}`, TRIANGLE, [], 'down', i);
    assert.equal(renderer.extraGeometryKeys().length, SECTION_2D_MAX_EXTRA_CAPS);
    renderer.uploadExtraDrawing('p0', TRIANGLE, [], 'down', 9);
    assert.equal(renderer.extraGeometryKeys().length, SECTION_2D_MAX_EXTRA_CAPS, 're-uploading a held cap is fine');
  });

  it('dispose releases every cap and the clip buffer', () => {
    const { renderer, created } = newRenderer();
    renderer.uploadDrawing(TRIANGLE, [], 'down', 1);
    renderer.uploadExtraDrawing('b', TRIANGLE, [], 'side', 2);
    renderer.dispose();
    assert.ok(created.every((buffer) => buffer.__destroyed === 1), `every buffer destroyed exactly once: ${created.map((b) => b.__destroyed)}`);
  });

  it('the eye-relative frame: distances are re-expressed against the camera in f64', () => {
    const { renderer, writes } = newRenderer();
    renderer.uploadDrawing(TRIANGLE, [], 'down', 5_000_000.25);
    const { pass } = makePass();
    // A 'down' cap lies at world y = the plane position, so the eye sits at that height too.
    const eye: [number, number, number] = [0, 5_000_000, 0];
    renderer.draw(pass, { ...OPTIONS, rteViewProj: new Float32Array(16), rteCamera: eye }, [plane(0, 1, 0, 5_000_000.5, 'b')]);
    assert.equal(decodeClip(clipWrites(writes)[0]!.data).distances[0], 0.5, 'the 5,000 km term is gone before the f32 write');
  });
});

describe('the cap shaders clip against the other planes (#7545)', () => {
  it('the fill and the cap outline discard through the shared test; the world-space lines do not', () => {
    assert.match(SECTION_2D_CAP_FILL_WGSL, /extraClipClipped\(extraClip, input\.clipPos\)/);
    assert.match(SECTION_2D_CAP_LINE_WGSL, /extraClipClipped\(extraClip, input\.clipPos\)/);
    assert.doesNotMatch(SECTION_2D_OVERLAY_LINE_WGSL, /extraClip/, 'annotation, grid and DXF lines are not cut by section planes');
    for (const wgsl of [SECTION_2D_CAP_FILL_WGSL, SECTION_2D_CAP_LINE_WGSL]) {
      assert.match(wgsl, /@binding\(0\) @group\(1\) var<uniform> extraClip: ExtraClip/);
      assert.match(wgsl, /output\.clipPos = relative/);
    }
  });
});

describe('cap highlight (#7950)', () => {
  const TWO = [
    ...TRIANGLE,
    { polygon: { outer: [{ x: 3, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1 }], holes: [] }, ifcType: 'IfcSlab', expressId: 2, color: [0.5, 0.5, 0.5, 1] as [number, number, number, number] },
  ];
  const lastFill = (writes: Rec[], created: Array<{ __size: number }>) =>
    [...writes].reverse().find((w) => created[w.buffer.__id].__size === w.data.byteLength && w.data.length === 6 * 7);
  const colorAt = (data: Float32Array, vertex: number) => Array.from(data.slice(vertex * 7 + 3, vertex * 7 + 7));

  it('recolours only the highlighted element, restores on clear, and survives a re-upload', () => {
    const { renderer, writes, created } = newRenderer();
    renderer.uploadDrawing(TWO, [], 'down', 1);
    renderer.setCapHighlight(new Map([['*:1', [0.3, 0.6, 1, 1]]]));
    let fill = lastFill(writes, created)!;
    assert.deepEqual(colorAt(fill.data, 0).map((v) => Math.round(v * 10) / 10), [0.3, 0.6, 1, 1], 'element 1 highlighted');
    assert.deepEqual(colorAt(fill.data, 3), [0.5, 0.5, 0.5, 1], 'element 2 untouched');

    const before = writes.length;
    renderer.setCapHighlight(new Map([['*:1', [0.3, 0.6, 1, 1]]]));
    assert.equal(writes.length, before, 'an unchanged highlight rewrites nothing');

    renderer.setCapHighlight(null);
    fill = lastFill(writes, created)!;
    assert.equal(colorAt(fill.data, 0)[3], -1, 'cleared: back to the uniform-fill sentinel');

    renderer.setCapHighlight(new Map([['*:2', [1, 0, 0, 1]]]));
    renderer.uploadDrawing(TWO, [], 'down', 2);
    fill = lastFill(writes, created)!;
    assert.deepEqual(colorAt(fill.data, 3), [1, 0, 0, 1], 'a re-upload (slider drag) keeps the highlight');
  });

  it('sees a Map mutated in place and passed again as a change', () => {
    const { renderer, writes, created } = newRenderer();
    renderer.uploadDrawing(TWO, [], 'down', 1);
    const highlight = new Map<string, readonly [number, number, number, number]>([['*:1', [1, 0, 0, 1]]]);
    renderer.setCapHighlight(highlight);
    const before = writes.length;
    highlight.set('*:2', [0, 1, 0, 1]);
    renderer.setCapHighlight(highlight);
    assert.ok(writes.length > before, 'the mutated map is rewritten');
    assert.deepEqual(colorAt(lastFill(writes, created)!.data, 3), [0, 1, 0, 1]);
  });

  it('does not rewrite the buffer for a highlight that matches nothing on this cap', () => {
    const { renderer, writes } = newRenderer();
    const miss = new Map<string, readonly [number, number, number, number]>([['*:99', [1, 0, 0, 1]]]);
    renderer.setCapHighlight(miss);
    renderer.uploadDrawing(TWO, [], 'down', 1);
    const before = writes.length;
    renderer.setCapHighlight(new Map(miss));
    assert.equal(writes.length, before);
  });
});
