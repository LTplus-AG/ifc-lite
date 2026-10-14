/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EXTRA_CLIP_FLOATS,
  MAX_EXTRA_CLIP_PLANES,
  extraClipWgsl,
  extraPlanesClip,
  packExtraClip,
} from './extra-clip-planes.js';
import { MESH_UNIFORM_FLOATS, MESH_UNIFORM_OFFSET, packRteFragmentSpace } from './mesh-rte-uniforms.js';
import { RelativeToEyeFrame } from './relative-to-eye.js';
import { MathUtils } from './math.js';
import { boxFullyClipped, clipIsActive, pointClipped } from './scene-raycaster.js';
import { sourceCurveClipIntervals } from './source-curve-clipping.js';
import { meshUniformsWgsl } from './shaders/mesh-uniforms.wgsl.js';
import { shadowShaderSource } from './shaders/shadow.wgsl.js';
import { pointShaderSource } from './pointcloud/point-shader.wgsl.js';
import type { ExtraClipPlane, PickClipState } from './types.js';

/** The WGSL `extraClipClipped` loop, ported statement for statement over a packed block. */
function shaderClipped(block: Float32Array, offset: number, p: readonly [number, number, number]): boolean {
  const meta = new Uint32Array(block.buffer, block.byteOffset + offset * 4, 2);
  for (let i = 0; i < meta[0]!; i++) {
    const base = offset + 4 + i * 4;
    const side = ((meta[1]! >> i) & 1) === 1 ? -1 : 1;
    if ((p[0] * block[base]! + p[1] * block[base + 1]! + p[2] * block[base + 2]! - block[base + 3]!) * side > 0) return true;
  }
  return false;
}

/** Deterministic xorshift so a failing case replays. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
}

function unit(r: () => number): [number, number, number] {
  const v: [number, number, number] = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
  const len = Math.hypot(...v) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function randomPlanes(r: () => number, count: number): ExtraClipPlane[] {
  return Array.from({ length: count }, () => ({ normal: unit(r), distance: (r() - 0.5) * 20, flipped: r() < 0.5 }));
}

describe('extra clip block layout (#7545)', () => {
  it('is 32 floats: meta then seven planes, and mirrors the WGSL declaration', () => {
    assert.equal(EXTRA_CLIP_FLOATS, 4 + 7 * 4);
    assert.equal(MAX_EXTRA_CLIP_PLANES, 7);
    assert.match(extraClipWgsl, /planeInfo: vec4<u32>/);
    assert.doesNotMatch(extraClipWgsl, /\bmeta\b\s*:/, 'meta is a reserved WGSL keyword and failed to compile on a real GPU');
    assert.match(extraClipWgsl, /array<vec4<f32>, 7>/);
  });

  it('writes count, flipped mask, normals and distances; no planes writes a zero count', () => {
    const planes: ExtraClipPlane[] = [
      { normal: [1, 0, 0], distance: 2, flipped: false },
      { normal: [0, 1, 0], distance: -3, flipped: true },
      { normal: [0, 0, 1], distance: 4, flipped: true },
    ];
    const out = new Float32Array(EXTRA_CLIP_FLOATS).fill(9);
    packExtraClip(planes, null, out, 0);
    const meta = new Uint32Array(out.buffer, 0, 2);
    assert.equal(meta[0], 3);
    assert.equal(meta[1], 0b110);
    assert.deepEqual([...out.slice(4, 8)], [1, 0, 0, 2]);
    assert.deepEqual([...out.slice(8, 12)], [0, 1, 0, -3]);
    assert.deepEqual([...out.slice(12, 16)], [0, 0, 1, 4]);
    packExtraClip(null, null, out, 0);
    assert.deepEqual([meta[0], meta[1]], [0, 0], 'a stale block is cleared by the count alone');
    packExtraClip([], null, out, 0);
    assert.equal(meta[0], 0);
  });

  it('drops planes past the capacity instead of wrapping', () => {
    const r = rng(7);
    const out = new Float32Array(EXTRA_CLIP_FLOATS);
    packExtraClip(randomPlanes(r, 12), null, out, 0);
    assert.equal(new Uint32Array(out.buffer, 0, 1)[0], MAX_EXTRA_CLIP_PLANES);
  });

  it('every pass that clips declares the block and calls the shared test', () => {
    for (const [name, wgsl] of [['mesh', meshUniformsWgsl], ['shadow', shadowShaderSource], ['points', pointShaderSource]] as const) {
      assert.match(wgsl, /struct ExtraClip/, `${name} declares ExtraClip`);
      assert.match(wgsl, /extraClipClipped\(/, `${name} calls extraClipClipped`);
    }
  });
});

describe('shader, CPU and ray tests agree on the same planes (#7545)', () => {
  it('packed-block loop == extraPlanesClip == pointClipped, over seeded planes and points, flipped or not', () => {
    const r = rng(0xc0ffee);
    for (let trial = 0; trial < 60; trial++) {
      const planes = randomPlanes(r, 1 + Math.floor(r() * 7));
      const block = new Float32Array(EXTRA_CLIP_FLOATS);
      packExtraClip(planes, null, block, 0);
      const clip: PickClipState = { extraPlanes: planes };
      for (let i = 0; i < 200; i++) {
        const p: [number, number, number] = [(r() - 0.5) * 30, (r() - 0.5) * 30, (r() - 0.5) * 30];
        const cpu = extraPlanesClip(planes, p[0], p[1], p[2]);
        assert.equal(shaderClipped(block, 0, p), cpu, 'shader loop vs CPU mirror');
        assert.equal(pointClipped(clip, p[0], p[1], p[2]), cpu, 'raycaster point test');
      }
    }
  });

  it('survives only where every plane keeps it: the kept set is the intersection', () => {
    const planes: ExtraClipPlane[] = [
      { normal: [1, 0, 0], distance: 1, flipped: false }, // keeps x <= 1
      { normal: [0, 1, 0], distance: 1, flipped: true },  // keeps y >= 1
    ];
    const clipped = (x: number, y: number) => extraPlanesClip(planes, x, y, 0);
    assert.equal(clipped(0, 2), false, 'kept by both');
    assert.equal(clipped(2, 2), true, 'removed by the first');
    assert.equal(clipped(0, 0), true, 'removed by the second');
    assert.equal(clipped(2, 0), true, 'removed by both');
  });

  it('boxFullyClipped is true exactly when one plane has every corner behind it', () => {
    const planes: ExtraClipPlane[] = [{ normal: [1, 0, 0], distance: 0, flipped: false }];
    const box = (min: number, max: number) => ({ min: { x: min, y: 0, z: 0 }, max: { x: max, y: 1, z: 1 } });
    assert.equal(boxFullyClipped({ extraPlanes: planes }, box(1, 2)), true);
    assert.equal(boxFullyClipped({ extraPlanes: planes }, box(-1, 2)), false, 'straddling is visible');
    assert.equal(boxFullyClipped({ extraPlanes: planes }, box(-2, -1)), false);
    // Never claims a box clipped that a sampled point inside it shows is visible.
    const r = rng(11);
    for (let i = 0; i < 300; i++) {
      const ps = randomPlanes(r, 1 + Math.floor(r() * 4));
      const a = (r() - 0.5) * 10; const b = (r() - 0.5) * 10; const c = (r() - 0.5) * 10;
      const bx = { min: { x: a, y: b, z: c }, max: { x: a + r() * 4, y: b + r() * 4, z: c + r() * 4 } };
      if (!boxFullyClipped({ extraPlanes: ps }, bx)) continue;
      for (let k = 0; k < 20; k++) {
        const x = bx.min.x + r() * (bx.max.x - bx.min.x);
        const y = bx.min.y + r() * (bx.max.y - bx.min.y);
        const z = bx.min.z + r() * (bx.max.z - bx.min.z);
        assert.equal(extraPlanesClip(ps, x, y, z), true, 'a point in a "fully clipped" box must itself be clipped');
      }
    }
  });

  it('clipIsActive sees extra planes alone', () => {
    assert.equal(clipIsActive({ extraPlanes: [] }), false);
    assert.equal(clipIsActive({ extraPlanes: [{ normal: [1, 0, 0], distance: 0, flipped: false }] }), true);
  });

  it('source curves are clipped against extra planes', () => {
    const line = {
      kind: 'line' as const,
      affineDisplayFrame: true,
      pointAt: (t: number) => ({ x: -2 + 4 * t, y: 0, z: 0 }),
    };
    const clip: PickClipState = { extraPlanes: [{ normal: [1, 0, 0], distance: 0, flipped: false }] };
    const intervals = sourceCurveClipIntervals(line as never, clip);
    assert.equal(intervals.length, 1);
    assert.ok(Math.abs(intervals[0]![1] - 0.5) < 1e-9, 'visible only up to x = 0');
  });
});

describe('extra planes ride the same f64 RTE frame as the primary plane (#5049, #7545)', () => {
  it('re-expresses each distance against the camera in f64: centimetre cuts survive 5,000 km', () => {
    const eye = [5_000_000, -3_000_000, 2_000_000] as const;
    const frame = new RelativeToEyeFrame();
    frame.update({ x: eye[0], y: eye[1], z: eye[2] }, MathUtils.identity(), MathUtils.identity());
    const out = new Float32Array(MESH_UNIFORM_FLOATS);
    const planes: ExtraClipPlane[] = [
      { normal: [1, 0, 0], distance: eye[0] + 0.25, flipped: false },
      { normal: [0, 0, 1], distance: eye[2] - 0.5, flipped: true },
    ];
    packRteFragmentSpace(frame, null, null, out, planes);
    const base = MESH_UNIFORM_OFFSET.extraClip;
    // distance - dot(eye, n): the metre-scale offset the shader sees, free of the 5,000 km term.
    assert.equal(out[base + 4 + 3], 0.25);
    assert.equal(out[base + 8 + 3], -0.5);
    // A point 1 cm either side of the first plane lands on the right sides.
    const near = new Float32Array(out.buffer, 0, MESH_UNIFORM_FLOATS);
    assert.equal(shaderClipped(near, base, [0.26, 0, 0]), true);
    assert.equal(shaderClipped(near, base, [0.24, 0, 0]), false);
  });

  it('packRteFragmentSpace without extras leaves a zero count, so one plane costs nothing extra', () => {
    const frame = new RelativeToEyeFrame();
    frame.update({ x: 0, y: 0, z: 0 }, MathUtils.identity(), MathUtils.identity());
    const out = new Float32Array(MESH_UNIFORM_FLOATS);
    new Uint32Array(out.buffer)[MESH_UNIFORM_OFFSET.extraClip] = 5; // stale from a previous frame
    packRteFragmentSpace(frame, { normal: [0, 1, 0], distance: 1, enabled: true }, null, out);
    assert.equal(new Uint32Array(out.buffer)[MESH_UNIFORM_OFFSET.extraClip], 0);
    assert.equal(out[MESH_UNIFORM_OFFSET.sectionPlane + 3], 1);
  });
});
