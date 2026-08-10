/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Section2DOverlayRenderer } from './section-2d-overlay.js';
import {
  SECTION_2D_UNIFORM_BYTES,
  SECTION_2D_UNIFORM_SLOTS,
  SECTION_2D_UNIFORM_SLOT_COUNT,
  SECTION_2D_UNIFORM_SLOT_INDEX,
} from './shaders/section-2d-overlay.wgsl.js';

// WebGPU enum globals referenced by the renderer's bind-group visibility and
// buffer usage flags (not defined in node) — same polyfill as
// paired-buffer-leak.test.ts / point-cloud-transform.test.ts.
(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

/**
 * `Section2DOverlayRenderer` is ONE nullable GPU object backing six buffer
 * families. Nothing pinned its ownership rules until this file: the clash-box
 * family (#1277) was the sixth added and was silently missing from `dispose()`,
 * so its vertex buffer leaked on every renderer teardown while the whole suite
 * stayed green. These tests count `createBuffer` against `destroy()` so the
 * seventh family cannot repeat it.
 */

interface FakeBuffer extends GPUBuffer {
  __destroyed: number;
  __size: number;
}

function makeDevice(minUniformBufferOffsetAlignment = 256) {
  const buffers: FakeBuffer[] = [];
  const writes: Array<{ buffer: GPUBuffer; offset: number; data: Float32Array }> = [];
  const device = {
    limits: { minUniformBufferOffsetAlignment } as unknown as GPUSupportedLimits,
    createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
    createPipelineLayout: () => ({}) as GPUPipelineLayout,
    createShaderModule: (desc: { code: string }) => ({ code: desc.code }) as unknown as GPUShaderModule,
    createRenderPipeline: (desc: unknown) => ({ desc }) as unknown as GPURenderPipeline,
    createBindGroup: () => ({}) as GPUBindGroup,
    createBuffer: (desc: { size: number }) => {
      const buf = {
        __destroyed: 0,
        __size: desc.size,
        destroy() {
          (this as FakeBuffer).__destroyed++;
        },
      } as unknown as FakeBuffer;
      buffers.push(buf);
      return buf as unknown as GPUBuffer;
    },
    queue: {
      writeBuffer: (buffer: GPUBuffer, offset: number, data: ArrayBufferView) => {
        writes.push({
          buffer,
          offset,
          data: new Float32Array(
            data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
          ),
        });
      },
    },
  } as unknown as GPUDevice;
  return { device, buffers, writes };
}

function makePass() {
  const calls: string[] = [];
  /** Dynamic bind-group offsets, in the order they were bound. */
  const binds: number[] = [];
  const pass = {
    setPipeline: () => calls.push('setPipeline'),
    setBindGroup: (_i: number, _g: GPUBindGroup, dynamicOffsets?: number[]) => {
      calls.push('setBindGroup');
      binds.push(dynamicOffsets?.[0] ?? 0);
    },
    setVertexBuffer: () => calls.push('setVertexBuffer'),
    setIndexBuffer: () => calls.push('setIndexBuffer'),
    draw: (n: number) => calls.push(`draw:${n}`),
    drawIndexed: (n: number) => calls.push(`drawIndexed:${n}`),
  } as unknown as GPURenderPassEncoder;
  return { pass, calls, binds };
}

/** Two segments = 12 floats, the minimum a family accepts. */
const SEGMENTS = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);

const OPTIONS = {
  axis: 'front' as const,
  position: 50,
  bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  viewProj: new Float32Array(16),
};
const CAP_STYLE = {
  fillColor: [1, 1, 1, 1] as [number, number, number, number],
  strokeColor: [0, 0, 0, 1] as [number, number, number, number],
  patternId: 0,
  spacingPx: 8,
  angleRad: 0,
  widthPx: 1,
  secondaryAngleRad: 0,
};
/**
 * A cap style whose every field is distinguishable from the zeroed cap-style
 * tail a world-space line draw writes. `CAP_STYLE` above is deliberately the
 * bland one, and `patternId: 0` there is indistinguishable from that zero —
 * which is exactly the confusion the uniform-slot tests must not fall into.
 */
const CAP_STYLE_HATCHED = {
  fillColor: [0.92, 0.88, 0.78, 1] as [number, number, number, number],
  strokeColor: [0.1, 0.1, 0.1, 1] as [number, number, number, number],
  patternId: 6,
  spacingPx: 12,
  angleRad: 0.5,
  widthPx: 2,
  secondaryAngleRad: -0.5,
};
const TRIANGLE = [{
  polygon: { outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], holes: [] },
  ifcType: 'IfcWall',
  expressId: 1,
}];

type Family = {
  name: string;
  upload: (r: Section2DOverlayRenderer, v: Float32Array) => void;
  clear: (r: Section2DOverlayRenderer) => void;
  has: (r: Section2DOverlayRenderer) => boolean;
  draw: (r: Section2DOverlayRenderer, p: GPURenderPassEncoder, vp: Float32Array) => void;
};

const FAMILIES: Family[] = [
  {
    name: 'annotation',
    upload: (r, v) => r.uploadAnnotationLines3D(v),
    clear: (r) => r.clearAnnotationLines3D(),
    has: (r) => r.hasAnnotationLines3D(),
    draw: (r, p, vp) => r.drawAnnotationLines3D(p, vp),
  },
  {
    name: 'alignment',
    upload: (r, v) => r.uploadAlignmentLines3D(v),
    clear: (r) => r.clearAlignmentLines3D(),
    has: (r) => r.hasAlignmentLines3D(),
    draw: (r, p, vp) => r.drawAlignmentLines3D(p, vp),
  },
  {
    name: 'grid',
    upload: (r, v) => r.uploadGridLines3D(v),
    clear: (r) => r.clearGridLines3D(),
    has: (r) => r.hasGridLines3D(),
    draw: (r, p, vp) => r.drawGridLines3D(p, vp),
  },
  {
    name: 'dxf',
    upload: (r, v) => r.uploadDxfLines3D(v),
    clear: (r) => r.clearDxfLines3D(),
    has: (r) => r.hasDxfLines3D(),
    draw: (r, p, vp) => r.drawDxfLines3D(p, vp),
  },
  {
    name: 'clashBox',
    upload: (r, v) => r.uploadClashBoxLines3D(v),
    clear: (r) => r.clearClashBoxLines3D(),
    has: (r) => r.hasClashBoxLines3D(),
    draw: (r, p, vp) => r.drawClashBoxLines3D(p, vp),
  },
];

function newRenderer(minUniformBufferOffsetAlignment = 256) {
  const { device, buffers, writes } = makeDevice(minUniformBufferOffsetAlignment);
  const renderer = new Section2DOverlayRenderer(device, 'bgra8unorm' as GPUTextureFormat, 4);
  return { renderer, buffers, writes };
}

describe('Section2DOverlayRenderer: per-family buffer ownership', () => {
  for (const family of FAMILIES) {
    it(`${family.name}: upload allocates, clear destroys, has() follows`, () => {
      const { renderer, buffers } = newRenderer();
      assert.strictEqual(family.has(renderer), false);

      family.upload(renderer, SEGMENTS);
      assert.strictEqual(family.has(renderer), true);
      const vertexBuffers = buffers.filter((b) => b.__size === SEGMENTS.byteLength);
      assert.strictEqual(vertexBuffers.length, 1);

      family.clear(renderer);
      assert.strictEqual(family.has(renderer), false);
      assert.strictEqual(vertexBuffers[0].__destroyed, 1);
    });

    it(`${family.name}: re-upload destroys the previous buffer (no leak per frame)`, () => {
      const { renderer, buffers } = newRenderer();
      family.upload(renderer, SEGMENTS);
      const first = buffers.filter((b) => b.__size === SEGMENTS.byteLength)[0];
      family.upload(renderer, SEGMENTS);
      assert.strictEqual(first.__destroyed, 1);
      assert.strictEqual(family.has(renderer), true);
    });

    it(`${family.name}: a sub-segment upload clears instead of allocating`, () => {
      const { renderer, buffers } = newRenderer();
      family.upload(renderer, SEGMENTS);
      const before = buffers.length;
      // 5 floats is less than one 6-float segment.
      family.upload(renderer, new Float32Array([1, 2, 3, 4, 5]));
      assert.strictEqual(family.has(renderer), false);
      assert.strictEqual(buffers.length, before, 'no buffer allocated for a partial segment');
    });

    it(`${family.name}: uploads whole segments only`, () => {
      // The vertex count went straight to `pass.draw()` as `length / 3`, so a
      // length that is not a multiple of 3 produced a FRACTIONAL count — a
      // WebGPU validation error that kills the whole command buffer, taking
      // every other overlay in the pass with it. A length that is a multiple
      // of 3 but an odd vertex count left a dangling half-segment the
      // line-list topology discards anyway. These arrays come from upstream
      // polyline/arc flatteners, not from hand-written literals.
      // Truncated to whole segments rather than rejected outright: a single
      // stray float from a flattener must not make an entire grid or DXF
      // layer vanish, which is what rejecting the whole array would do.
      for (const [floats, expectedVertices] of [
        [5, 0],   // under one segment — the documented "no lines" spelling
        [7, 2],   // 2.33 vertices: the FRACTIONAL count, floored to one segment
        [8, 2],   // 2.67 vertices
        [9, 2],   // 3 whole vertices: one segment, one dangling vertex
        [12, 4],  // exactly two segments
        [15, 4],  // 5 vertices: two whole segments, one dangling
        [18, 6],  // exactly three segments
      ] as const) {
        const { renderer } = newRenderer();
        family.upload(renderer, new Float32Array(floats).map((_, i) => i));
        const { pass, calls } = makePass();
        family.draw(renderer, pass, new Float32Array(16));
        const drawCall = calls.find((c) => c.startsWith('draw:'));
        if (expectedVertices === 0) {
          assert.strictEqual(family.has(renderer), false, `${floats} floats should not upload`);
          assert.strictEqual(drawCall, undefined, `${floats} floats should not draw`);
        } else {
          assert.strictEqual(drawCall, `draw:${expectedVertices}`, `${floats} floats`);
        }
      }
    });

    it(`${family.name}: never allocates room for a partial segment`, () => {
      // The buffer must be sized to the vertices actually drawn, or the tail
      // is uninitialised GPU memory that a later count bump would render.
      const { renderer, buffers } = newRenderer();
      family.upload(renderer, new Float32Array(15).map((_, i) => i));
      const vertexBuffer = buffers.find((b) => b.__size === 12 * 4);
      assert.ok(vertexBuffer, `expected a 48-byte buffer, saw ${buffers.map((b) => b.__size)}`);
    });

    it(`${family.name}: draw is a no-op when the family is empty`, () => {
      const { renderer } = newRenderer();
      const { pass, calls } = makePass();
      family.draw(renderer, pass, new Float32Array(16));
      assert.deepStrictEqual(calls, []);
    });

    it(`${family.name}: draw issues exactly one draw of the uploaded vertex count`, () => {
      const { renderer } = newRenderer();
      family.upload(renderer, SEGMENTS);
      const { pass, calls } = makePass();
      family.draw(renderer, pass, new Float32Array(16));
      assert.deepStrictEqual(calls, ['setPipeline', 'setBindGroup', 'setVertexBuffer', 'draw:4']);
    });
  }

  it('families are independent: clearing one leaves the others uploaded', () => {
    const { renderer } = newRenderer();
    for (const f of FAMILIES) f.upload(renderer, SEGMENTS);
    FAMILIES[2].clear(renderer);
    for (const f of FAMILIES) {
      assert.strictEqual(f.has(renderer), f !== FAMILIES[2], `${f.name} after clearing grid`);
    }
  });
});

describe('Section2DOverlayRenderer: dispose releases EVERY family (#1277 leak)', () => {
  it('destroys every uploaded family buffer and the shared uniform buffer', () => {
    const { renderer, buffers } = newRenderer();
    for (const f of FAMILIES) f.upload(renderer, SEGMENTS);
    renderer.uploadDrawing(
      [{
        polygon: { outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], holes: [] },
        ifcType: 'IfcWall',
        expressId: 1,
      }],
      [],
      'front',
      0,
    );

    assert.ok(buffers.length >= FAMILIES.length + 3, `allocated ${buffers.length} buffers`);
    renderer.dispose();

    const leaked = buffers.filter((b) => b.__destroyed === 0);
    assert.deepStrictEqual(
      leaked.map((b) => b.__size),
      [],
      'every GPU buffer the renderer created must be destroyed by dispose()',
    );
  });

  it('reports every family empty after dispose', () => {
    const { renderer } = newRenderer();
    for (const f of FAMILIES) f.upload(renderer, SEGMENTS);
    renderer.dispose();
    for (const f of FAMILIES) {
      assert.strictEqual(f.has(renderer), false, `${f.name} still reports geometry after dispose`);
    }
    assert.strictEqual(renderer.hasGeometry(), false);
  });

  it('is idempotent — a second dispose does not double-destroy', () => {
    const { renderer, buffers } = newRenderer();
    for (const f of FAMILIES) f.upload(renderer, SEGMENTS);
    renderer.dispose();
    renderer.dispose();
    for (const b of buffers) {
      assert.strictEqual(b.__destroyed, 1, 'each buffer destroyed exactly once');
    }
  });
});

describe('Section2DOverlayRenderer: shared uniform buffer', () => {
  function lastWrite(writes: Array<{ data: Float32Array }>): Float32Array {
    assert.ok(writes.length > 0, 'expected a uniform write');
    return writes[writes.length - 1].data;
  }

  it('writes the overlay line colour at the lineColor slot for a shared-colour family', () => {
    const { renderer, writes } = newRenderer();
    renderer.setOverlayLineColor([0.1, 0.2, 0.3, 0.4]);
    renderer.uploadGridLines3D(SEGMENTS);
    const { pass } = makePass();
    renderer.drawGridLines3D(pass, new Float32Array(16).fill(0));
    const u = lastWrite(writes);
    assert.deepStrictEqual(
      Array.from(u.slice(SECTION_2D_UNIFORM_SLOTS.lineColor, SECTION_2D_UNIFORM_SLOTS.lineColor + 4))
        .map((v) => Math.round(v * 1000) / 1000),
      [0.1, 0.2, 0.3, 0.4],
    );
  });

  it('draws the clash box in its OWN colour, not the shared overlay colour', () => {
    const { renderer, writes } = newRenderer();
    renderer.setOverlayLineColor([0.1, 0.2, 0.3, 0.4]);
    renderer.setClashBoxLineColor([1, 0, 0, 1]);
    renderer.uploadClashBoxLines3D(SEGMENTS);
    const { pass } = makePass();
    renderer.drawClashBoxLines3D(pass, new Float32Array(16).fill(0));
    const u = lastWrite(writes);
    assert.deepStrictEqual(
      Array.from(u.slice(SECTION_2D_UNIFORM_SLOTS.lineColor, SECTION_2D_UNIFORM_SLOTS.lineColor + 4)),
      [1, 0, 0, 1],
    );
  });

  it('zeroes planeOffset for world-space families', () => {
    const { renderer, writes } = newRenderer();
    renderer.uploadAnnotationLines3D(SEGMENTS);
    const { pass } = makePass();
    renderer.drawAnnotationLines3D(pass, new Float32Array(16).fill(7));
    const u = lastWrite(writes);
    assert.deepStrictEqual(
      Array.from(u.slice(SECTION_2D_UNIFORM_SLOTS.planeOffset, SECTION_2D_UNIFORM_SLOTS.planeOffset + 4)),
      [0, 0, 0, 0],
    );
    assert.deepStrictEqual(Array.from(u.slice(0, 16)), new Array(16).fill(7));
  });

  it('places the cap style at the capFill / capStroke / params slots', () => {
    const { renderer, writes } = newRenderer();
    renderer.uploadDrawing(
      [{
        polygon: { outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], holes: [] },
        ifcType: 'IfcWall',
        expressId: 1,
      }],
      [],
      'front',
      0,
    );
    const { pass } = makePass();
    renderer.draw(pass, {
      axis: 'front',
      position: 50,
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      viewProj: new Float32Array(16),
      showFills: true,
      capStyle: {
        fillColor: [0.5, 0.6, 0.7, 0.8],
        strokeColor: [0.1, 0.2, 0.3, 0.9],
        patternId: 5,
        spacingPx: 11,
        angleRad: 0.25,
        widthPx: 3,
        secondaryAngleRad: -0.25,
      },
    });
    const u = lastWrite(writes);
    const S = SECTION_2D_UNIFORM_SLOTS;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    assert.deepStrictEqual(Array.from(u.slice(S.capFillColor, S.capFillColor + 4)).map(round), [0.5, 0.6, 0.7, 0.8]);
    assert.deepStrictEqual(Array.from(u.slice(S.capStrokeColor, S.capStrokeColor + 4)).map(round), [0.1, 0.2, 0.3, 0.9]);
    assert.deepStrictEqual(Array.from(u.slice(S.params, S.params + 4)).map(round), [5, 11, 0.25, 3]);
    assert.strictEqual(round(u[S.params2]), -0.25);
  });

  it('falls back to the warm-paper defaults with no hatch when capStyle is omitted', () => {
    const { renderer, writes } = newRenderer();
    renderer.uploadDrawing([], [{ line: { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }, category: 'cut' }], 'front', 0);
    const { pass } = makePass();
    renderer.draw(pass, {
      axis: 'front',
      position: 50,
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      viewProj: new Float32Array(16),
    });
    const u = lastWrite(writes);
    const S = SECTION_2D_UNIFORM_SLOTS;
    const round = (v: number) => Math.round(v * 100) / 100;
    assert.deepStrictEqual(Array.from(u.slice(S.capFillColor, S.capFillColor + 4)).map(round), [0.92, 0.88, 0.78, 1]);
    assert.strictEqual(u[S.params], 0, 'solid pattern');
  });
});

describe('Section2DOverlayRenderer: section-cut draw gating', () => {
  it('draws nothing before any upload', () => {
    const { renderer } = newRenderer();
    const { pass, calls } = makePass();
    renderer.draw(pass, OPTIONS);
    assert.deepStrictEqual(calls, []);
  });

  it('draws outlines but NOT fills unless showFills and capStyle are both set', () => {
    const { renderer } = newRenderer();
    renderer.uploadDrawing(TRIANGLE, [], 'front', 0);
    const { pass, calls } = makePass();
    renderer.draw(pass, OPTIONS);
    assert.ok(!calls.some((c) => c.startsWith('drawIndexed')), 'no fill without showFills');
    assert.ok(calls.some((c) => c.startsWith('draw:')), 'outline still drawn');
  });

  it('draws the fill when showFills and capStyle are supplied', () => {
    const { renderer } = newRenderer();
    renderer.uploadDrawing(TRIANGLE, [], 'front', 0);
    const { pass, calls } = makePass();
    renderer.draw(pass, { ...OPTIONS, showFills: true, capStyle: CAP_STYLE });
    assert.ok(calls.some((c) => c.startsWith('drawIndexed:')), 'fill drawn');
  });

  it('suppresses the outline when showOutlines is false', () => {
    const { renderer } = newRenderer();
    renderer.uploadDrawing(TRIANGLE, [], 'front', 0);
    const { pass, calls } = makePass();
    renderer.draw(pass, { ...OPTIONS, showOutlines: false, showFills: true, capStyle: CAP_STYLE });
    assert.ok(!calls.some((c) => /^draw:/.test(c)), 'no outline draw');
    assert.ok(calls.some((c) => c.startsWith('drawIndexed:')), 'fill still drawn');
  });

  it('clearGeometry drops the cut buffers without touching the line families', () => {
    const { renderer } = newRenderer();
    renderer.uploadDrawing(TRIANGLE, [], 'front', 0);
    renderer.uploadGridLines3D(SEGMENTS);
    assert.strictEqual(renderer.hasGeometry(), true);
    renderer.clearGeometry();
    assert.strictEqual(renderer.hasGeometry(), false);
    assert.strictEqual(renderer.hasGridLines3D(), true);
  });

  it('re-uploading the drawing destroys the previous cut buffers', () => {
    const { renderer, buffers } = newRenderer();
    renderer.uploadDrawing(TRIANGLE, [], 'front', 0);
    // Everything except the shared uniform buffer, which `init()` owns and
    // re-uploading the drawing must not touch. Sized by slot count now, so
    // this can no longer be spelled `!== 160`.
    const uniformSize = SECTION_2D_UNIFORM_SLOT_COUNT * 256;
    const cutBuffers = buffers.filter((b) => b.__size !== uniformSize);
    assert.ok(cutBuffers.length >= 2, 'fill vertex + index (+ outline) buffers');
    renderer.uploadDrawing(TRIANGLE, [], 'front', 0);
    for (const b of cutBuffers) {
      assert.strictEqual(b.__destroyed, 1, 'previous cut buffer destroyed on re-upload');
    }
  });
});

/**
 * Six draws, six uniform records.
 *
 * `Section2DOverlayRenderer` encodes the cut cap and up to five world-space
 * line families into ONE render pass (`renderer-overlays.ts` calls them one
 * after another), and each needs different uniforms. They all wrote byte 0 of
 * one 160-byte buffer. `queue.writeBuffer` is a *queue* operation: it is
 * applied before the command buffer that references the buffer executes,
 * wherever in the encoding it was issued. So the last write before submit is
 * what all six draws read — the clash box's magenta bleeding onto every other
 * overlay, and the cap's fill colour and hatch replaced by the zeroed tail a
 * line draw writes. Pre-existing on `origin/main`, where the same six draws
 * write `this.uniformBuffer` at offset 0.
 */
describe('Section2DOverlayRenderer: one uniform record per draw (#2456)', () => {
  /** Everything a full overlay frame draws, in `renderer-overlays.ts` order. */
  function drawWholeFrame(renderer: Section2DOverlayRenderer, pass: GPURenderPassEncoder): void {
    renderer.draw(pass, { ...OPTIONS, showFills: true, capStyle: CAP_STYLE_HATCHED });
    for (const f of FAMILIES) f.draw(renderer, pass, new Float32Array(16).fill(0));
  }

  it('every draw in one pass reads a different slot', () => {
    const { renderer, writes } = newRenderer();
    renderer.setOverlayLineColor([0.1, 0.2, 0.3, 1]);
    renderer.setClashBoxLineColor([1, 0, 1, 1]);
    renderer.uploadDrawing(TRIANGLE, [], 'front', 0);
    for (const f of FAMILIES) f.upload(renderer, SEGMENTS);

    const { pass, binds } = makePass();
    const uniformWritesBefore = writes.length;
    drawWholeFrame(renderer, pass);

    // One uniform write per draw site: the cap (which its fill and outline
    // share by design) plus the five families.
    const uniformOffsets = writes.slice(uniformWritesBefore).map((w) => w.offset);
    assert.strictEqual(uniformOffsets.length, SECTION_2D_UNIFORM_SLOT_COUNT);
    assert.strictEqual(
      new Set(uniformOffsets).size,
      SECTION_2D_UNIFORM_SLOT_COUNT,
      `the six draws must not share a record; offsets were ${JSON.stringify(uniformOffsets)}`,
    );

    // …and every bound record must be one that was actually written for it.
    // 7 binds: cap fill + cap outline (same slot) + five families.
    assert.strictEqual(binds.length, SECTION_2D_UNIFORM_SLOT_COUNT + 1);
    assert.strictEqual(
      new Set(binds).size,
      SECTION_2D_UNIFORM_SLOT_COUNT,
      'the cap fill and outline share slot 0; the five families do not share anything',
    );
    for (const offset of binds) {
      assert.ok(uniformOffsets.includes(offset), `nothing was written to bound offset ${offset}`);
    }
  });

  it('the clash box colour cannot reach the other families', () => {
    // The user-visible symptom, asserted on the bytes each draw binds rather
    // than on "the last write": with one shared record the grid draw bound a
    // record that held magenta by the time the pass ran.
    const { renderer, writes } = newRenderer();
    renderer.setOverlayLineColor([0.1, 0.2, 0.3, 1]);
    renderer.setClashBoxLineColor([1, 0, 1, 1]);
    renderer.uploadGridLines3D(SEGMENTS);
    renderer.uploadClashBoxLines3D(SEGMENTS);

    const { pass, binds } = makePass();
    const before = writes.length;
    renderer.drawGridLines3D(pass, new Float32Array(16).fill(0));
    renderer.drawClashBoxLines3D(pass, new Float32Array(16).fill(0));

    // Resolve what the GPU would see for the FIRST draw: the last write to the
    // offset that draw bound. That is exactly the queue semantics that made
    // this a bug.
    const gridOffset = binds[0];
    const settled = writes.slice(before).filter((w) => w.offset === gridOffset).pop();
    assert.ok(settled, 'the grid draw bound an offset nothing was written to');
    const C = SECTION_2D_UNIFORM_SLOTS.lineColor;
    assert.deepStrictEqual(
      Array.from(settled.data.slice(C, C + 4)).map((v) => Math.round(v * 1000) / 1000),
      [0.1, 0.2, 0.3, 1],
      'the grid must still be drawn in the shared overlay colour, not the clash magenta',
    );
  });

  it('the cap style survives the line families drawn after it', () => {
    // The cap writes its fill colour, stroke and hatch params; every line draw
    // writes a record whose whole cap-style tail is zero. Sharing one record
    // meant the cap rendered with a transparent black fill and pattern 0.
    const { renderer, writes } = newRenderer();
    renderer.uploadDrawing(TRIANGLE, [], 'front', 0);
    for (const f of FAMILIES) f.upload(renderer, SEGMENTS);

    const { pass, binds } = makePass();
    const before = writes.length;
    drawWholeFrame(renderer, pass);

    const capOffset = binds[0];
    const settled = writes.slice(before).filter((w) => w.offset === capOffset).pop();
    assert.ok(settled, 'the cap bound an offset nothing was written to');
    const F = SECTION_2D_UNIFORM_SLOTS.capFillColor;
    assert.deepStrictEqual(
      Array.from(settled.data.slice(F, F + 4)).map((v) => Math.round(v * 100) / 100),
      Array.from(CAP_STYLE_HATCHED.fillColor),
      'the cap fill colour must survive the five line draws encoded after it',
    );
    assert.strictEqual(
      settled.data[SECTION_2D_UNIFORM_SLOTS.params],
      CAP_STYLE_HATCHED.patternId,
      'the cap hatch pattern must survive too',
    );
  });

  it('slot offsets follow the device alignment, not a hard-coded 256', () => {
    // `minUniformBufferOffsetAlignment` is a device limit; 256 is only the
    // guaranteed-supported default. A device reporting 64 must still get
    // records that fit the 160-byte struct.
    const { renderer, writes, buffers } = (() => {
      const r = newRenderer(64);
      return r;
    })();
    renderer.uploadGridLines3D(SEGMENTS);
    renderer.uploadClashBoxLines3D(SEGMENTS);
    const { pass } = makePass();
    const before = writes.length;
    renderer.drawGridLines3D(pass, new Float32Array(16).fill(0));
    renderer.drawClashBoxLines3D(pass, new Float32Array(16).fill(0));

    const offsets = writes.slice(before).map((w) => w.offset);
    const stride = 192; // ceil(160 / 64) * 64
    for (const o of offsets) {
      assert.strictEqual(o % 64, 0, `offset ${o} is not 64-byte aligned`);
    }
    assert.strictEqual(
      offsets[1] - offsets[0],
      (SECTION_2D_UNIFORM_SLOT_INDEX.clashBox - SECTION_2D_UNIFORM_SLOT_INDEX.grid) * stride,
    );
    const uniform = buffers.find((b) => b.__size === stride * SECTION_2D_UNIFORM_SLOT_COUNT);
    assert.ok(uniform, `no uniform buffer of ${stride * SECTION_2D_UNIFORM_SLOT_COUNT} bytes`);
    assert.ok(stride >= SECTION_2D_UNIFORM_BYTES, 'a slot must hold the whole struct');
  });
});
