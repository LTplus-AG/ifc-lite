/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAP_FILL_VERTEX_ATTRIBUTES,
  CAP_FILL_VERTEX_FLOATS,
  CAP_HATCH_OVERRIDE,
  buildCapFillGeometry,
  capHighlightKey,
  createSectionLift,
  recolorCapVertices,
  type CutPolygon2D,
} from './section-2d-lift.js';
import { SECTION_CAP_FILL_VERTEX_BUFFER } from './section-cap-pipelines.js';
import { Section2DOverlayRenderer } from './section-2d-overlay.js';
import { SECTION_2D_CAP_FILL_WGSL, SECTION_2D_UNIFORM_FLOATS } from './shaders/section-2d-overlay.wgsl.js';

/**
 * Per-polygon hatch on section caps (#8753): `CutPolygon2D.hatch` rides in the
 * cap fill vertex next to `color`, with a per-field override mask so missing
 * fields fall back to the upload's `capStyle`. Without `hatch` the cap must be
 * exactly what it was.
 */

(globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 };
(globalThis as Record<string, unknown>).GPUBufferUsage ??= {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
};

const F = CAP_FILL_VERTEX_FLOATS;
const lift = createSectionLift('front', 0);
const OPTIONS = {
  axis: 'down' as const, position: 1, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  viewProj: new Float32Array(16), showFills: true, showOutlines: true,
  capStyle: {
    fillColor: [1, 1, 1, 1] as [number, number, number, number], strokeColor: [0, 0, 0, 1] as [number, number, number, number],
    patternId: 1, spacingPx: 8, angleRad: 0.5, widthPx: 1, secondaryAngleRad: -0.5,
  },
};

function tri(dx: number, extra: Partial<CutPolygon2D> = {}): CutPolygon2D {
  return {
    polygon: { outer: [{ x: dx, y: 0 }, { x: dx + 1, y: 0 }, { x: dx, y: 1 }], holes: [] },
    ifcType: 'IfcWall',
    expressId: 1,
    ...extra,
  };
}

/** One vertex's floats, by attribute name. */
function attr(vertices: Float32Array, vertex: number, name: (typeof CAP_FILL_VERTEX_ATTRIBUTES)[number]['name']): number[] {
  const a = CAP_FILL_VERTEX_ATTRIBUTES.find((x) => x.name === name)!;
  const o = vertex * F + a.offset;
  return Array.from(vertices.slice(o, o + a.floats));
}

const vertexCount = (vertices: Float32Array) => vertices.length / F;
const maskOf = (vertices: Float32Array, v: number) => attr(vertices, v, 'hatchB')[1];

describe('cap fill vertex: per-polygon hatch (#8753)', () => {
  it('without `hatch`: position and colour floats match the old 7-float layout, every mask is 0', () => {
    const color: [number, number, number, number] = [0.25, 0.5, 0.75, 1];
    const fill = buildCapFillGeometry([tri(0), tri(3, { color })], lift)!;
    // The pre-#8753 layout, written out by hand: lift(x, y) then RGBA (sentinel alpha −1 when uncoloured).
    const old: number[][] = [];
    for (const [dx, c] of [[0, [0, 0, 0, -1]], [3, color]] as const) {
      for (const [x, y] of [[dx, 0], [dx + 1, 0], [dx, 1]]) old.push([...lift(x, y), ...c]);
    }
    assert.equal(vertexCount(fill.vertices), old.length);
    for (let v = 0; v < old.length; v++) {
      assert.deepEqual([...attr(fill.vertices, v, 'position'), ...attr(fill.vertices, v, 'color')], old[v]);
      assert.deepEqual(
        [...attr(fill.vertices, v, 'hatchA'), ...attr(fill.vertices, v, 'hatchB'), ...attr(fill.vertices, v, 'hatchStroke')],
        new Array(12).fill(0),
        'no hatch ⇒ all hatch floats (and the override mask) are 0',
      );
    }
  });

  it('two polygons in one upload carry their own patternId; colours are unchanged', () => {
    const color: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
    const fill = buildCapFillGeometry([
      tri(0, { color, hatch: { patternId: 1 } }),
      tri(3, { color, hatch: { patternId: 5 } }),
    ], lift)!;
    const [a, b] = fill.ranges;
    for (const [range, patternId] of [[a, 1], [b, 5]] as const) {
      for (let v = range.vertexStart; v < range.vertexStart + range.vertexCount; v++) {
        assert.equal(attr(fill.vertices, v, 'hatchA')[0], patternId);
        assert.equal(maskOf(fill.vertices, v) & CAP_HATCH_OVERRIDE.patternId, CAP_HATCH_OVERRIDE.patternId);
        assert.deepEqual(attr(fill.vertices, v, 'color'), color);
      }
    }
  });

  it('a partial hatch (patternId only) sets only bit 0, so every other field inherits capStyle', () => {
    const fill = buildCapFillGeometry([tri(0, { hatch: { patternId: 2 } })], lift)!;
    for (let v = 0; v < vertexCount(fill.vertices); v++) assert.equal(maskOf(fill.vertices, v), 1);
  });

  it('sets one bit per supplied field, including zero and negative angles', () => {
    const fill = buildCapFillGeometry([tri(0, {
      hatch: { patternId: 2, angleRad: 0, secondaryAngleRad: -0.5, strokeColor: [1, 0, 0, 1] },
    })], lift)!;
    const O = CAP_HATCH_OVERRIDE;
    assert.equal(maskOf(fill.vertices, 0), O.patternId | O.angleRad | O.secondaryAngleRad | O.strokeColor);
    assert.deepEqual(attr(fill.vertices, 0, 'hatchA'), [2, 0, 0, 0]);
    assert.equal(attr(fill.vertices, 0, 'hatchB')[0], -0.5);
    assert.deepEqual(attr(fill.vertices, 0, 'hatchStroke'), [1, 0, 0, 1]);
  });

  it('highlight recolours as before and leaves the hatch floats untouched', () => {
    const fill = buildCapFillGeometry([
      tri(0, { expressId: 7, color: [0.5, 0.5, 0.5, 1], hatch: { patternId: 6, spacingPx: 12, strokeColor: [0, 0, 1, 1] } }),
      tri(3, { expressId: 9, hatch: { patternId: 7 } }),
    ], lift)!;
    const out = recolorCapVertices(fill.vertices, fill.ranges, new Map([[capHighlightKey(undefined, 7), [1, 0, 0, 1] as const]]))!;
    assert.ok(out);
    for (let v = 0; v < vertexCount(fill.vertices); v++) {
      const highlighted = v < fill.ranges[1].vertexStart;
      assert.deepEqual(attr(out, v, 'color'), highlighted ? [1, 0, 0, 1] : attr(fill.vertices, v, 'color'));
      for (const name of ['position', 'hatchA', 'hatchB', 'hatchStroke'] as const) {
        assert.deepEqual(attr(out, v, name), attr(fill.vertices, v, name), `${name} of vertex ${v}`);
      }
    }
  });
});

describe('cap fill vertex layout: TS ⇄ pipeline ⇄ WGSL', () => {
  it('the pipeline stride is CAP_FILL_VERTEX_FLOATS × 4 and the attributes tile it exactly', () => {
    assert.equal(SECTION_CAP_FILL_VERTEX_BUFFER.arrayStride, CAP_FILL_VERTEX_FLOATS * 4);
    let cursor = 0;
    for (const a of CAP_FILL_VERTEX_ATTRIBUTES) {
      assert.equal(a.offset, cursor, `${a.name} follows the previous attribute`);
      cursor += a.floats;
    }
    assert.equal(cursor, CAP_FILL_VERTEX_FLOATS);
    assert.deepEqual(
      Array.from(SECTION_CAP_FILL_VERTEX_BUFFER.attributes).map((a) => [a.shaderLocation, a.offset, a.format]),
      CAP_FILL_VERTEX_ATTRIBUTES.map((a) => [a.shaderLocation, a.offset * 4, `float32x${a.floats}`]),
    );
  });

  it('the fill shader VertexInput declares the same locations, names and widths', () => {
    const body = SECTION_2D_CAP_FILL_WGSL.match(/struct\s+VertexInput\s*\{([\s\S]*?)\}/)?.[1];
    assert.ok(body, 'fill shader declares VertexInput');
    const fields = [...body.matchAll(/@location\((\d+)\)\s+(\w+)\s*:\s*vec(\d)<f32>/g)]
      .map(([, loc, name, n]) => [Number(loc), name, Number(n)]);
    assert.deepEqual(fields, CAP_FILL_VERTEX_ATTRIBUTES.map((a) => [a.shaderLocation, a.name, a.floats]));
  });

  it('the hatch varyings are flat (one value per polygon, no interpolation)', () => {
    for (const name of ['hatchA', 'hatchB', 'hatchStroke']) {
      assert.ok(new RegExp(`@interpolate\\(flat\\)\\s+${name}:`).test(SECTION_2D_CAP_FILL_WGSL), name);
    }
  });

  it('the real fill and depth pipelines are created with that vertex buffer', () => {
    const { renderer, pipelines } = recordingRenderer();
    renderer.uploadDrawing([tri(0)], [], 'down', 1); // pipelines are built on first use
    const capPipelines = pipelines.filter((p) => p.vertex.buffers?.[0] === SECTION_CAP_FILL_VERTEX_BUFFER);
    assert.equal(capPipelines.length, 2, 'fill + depth');
  });

  it('a hatched upload writes the same uniform record as an unhatched one', () => {
    const record = (polygons: CutPolygon2D[]) => {
      const { renderer, writes } = recordingRenderer();
      renderer.uploadDrawing(polygons, [], 'down', 1);
      renderer.draw(noopPass(), OPTIONS, []);
      return writes.filter((w) => w.length === SECTION_2D_UNIFORM_FLOATS).map((w) => Array.from(w));
    };
    const plain = record([tri(0)]);
    assert.equal(plain.length, 1);
    assert.deepEqual(record([tri(0, { hatch: { patternId: 4, spacingPx: 3, strokeColor: [1, 0, 0, 1] } })]), plain);
  });
});

function noopPass(): GPURenderPassEncoder {
  const noop = () => {};
  return {
    setPipeline: noop, setVertexBuffer: noop, setIndexBuffer: noop, setBindGroup: noop, draw: noop, drawIndexed: noop,
  } as unknown as GPURenderPassEncoder;
}

/** The real overlay renderer over a device that records pipeline descriptors and buffer writes. */
function recordingRenderer() {
  const writes: Float32Array[] = [];
  const pipelines: GPURenderPipelineDescriptor[] = [];
  const device = {
    limits: { minUniformBufferOffsetAlignment: 256 },
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createShaderModule: (d: { code: string }) => ({ code: d.code }),
    createRenderPipeline: (d: GPURenderPipelineDescriptor) => { pipelines.push(d); return {}; },
    createBindGroup: () => ({}),
    createBuffer: () => ({ destroy() {} }),
    queue: {
      writeBuffer: (_b: unknown, _o: number, data: ArrayBufferView) => {
        writes.push(new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
      },
    },
  } as unknown as GPUDevice;
  const renderer = new Section2DOverlayRenderer(device, 'rgba8unorm' as GPUTextureFormat, 4);
  return { renderer, writes, pipelines };
}
