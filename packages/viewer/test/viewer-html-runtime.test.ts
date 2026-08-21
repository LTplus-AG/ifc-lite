/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the browser-free logic that ships inside the viewer blob.
 *
 * See `test/helpers/blob.ts` for the extraction contract. Only declarations
 * that touch no browser API are lifted; the GL/DOM wiring around them is left
 * to the E2E lanes on purpose.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPT,
  assertBrowserFree,
  extractBetween,
  extractDecl,
  loadDecls,
} from './helpers/blob.js';

// ── Harness self-checks ─────────────────────────────────────────────────────

describe('viewer blob harness', () => {
  it('extracts real source, not an empty or truncated body', () => {
    const src = extractDecl('resolveColor');
    assert.match(src, /^function resolveColor\(c\) \{/);
    assert.match(src, /\}$/);
    assert.ok(src.includes('NAMED_COLORS'), 'body was truncated before its first statement');
  });

  it('fails loudly when a declaration is missing rather than testing nothing', () => {
    assert.throws(() => extractDecl('noSuchFunctionInTheBlob'), /not found in the viewer blob/);
  });

  it('fails loudly when an anchor is missing', () => {
    assert.throws(() => extractBetween('no such anchor', '}'), /anchor not found/);
  });

  it('rejects a declaration that reaches for the browser', () => {
    assert.throws(
      () => assertBrowserFree('fake', 'function fake() { return document.title; }'),
      /no longer node-testable/,
    );
  });
});

const round = (v: number) => Math.round(v * 1000) / 1000;
/** Widen a lifted Float32Array to a plain number[] for assertions. */
const nums = (a: unknown): number[] => Array.from(a as Float32Array);

// ── 1. Matrix math ──────────────────────────────────────────────────────────

const { mat4 } = loadDecls(['mat4']);

describe('viewer blob — mat4', () => {
  it('is browser-free', () => assertBrowserFree('mat4'));

  it('create() is the identity matrix', () => {
    assert.deepEqual(
      Array.from(mat4.create()),
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    );
  });

  it('perspective() writes the standard right-handed, [-1,1]-depth projection', () => {
    const near = 1;
    const far = 100;
    const aspect = 2;
    const fov = Math.PI / 2; // f === 1
    const m = nums(mat4.perspective(fov, aspect, near, far));
    const f = 1 / Math.tan(fov / 2);
    assert.ok(Math.abs(m[0] - f / aspect) < 1e-6, 'm[0] must divide by aspect');
    assert.ok(Math.abs(m[5] - f) < 1e-6, 'm[5] must not divide by aspect');
    assert.ok(Math.abs(m[10] - (far + near) / (near - far)) < 1e-6, 'm[10] depth scale');
    assert.equal(m[11], -1, 'w must receive -z for perspective divide');
    assert.ok(Math.abs(m[14] - (2 * far * near) / (near - far)) < 1e-6, 'm[14] depth offset');
    assert.equal(m[15], 0);
  });

  it('perspective() maps the near plane to -1 and the far plane to +1', () => {
    const m = mat4.perspective(Math.PI / 4, 1.5, 2, 500);
    const depth = (z: number) => (m[10] * z + m[14]) / -z;
    assert.ok(Math.abs(depth(-2) - -1) < 1e-5, 'near plane must land on -1');
    assert.ok(Math.abs(depth(-500) - 1) < 1e-5, 'far plane must land on +1');
  });

  it('perspective() narrows x, not y, as aspect grows', () => {
    const wide = mat4.perspective(Math.PI / 4, 4, 1, 100);
    const square = mat4.perspective(Math.PI / 4, 1, 1, 100);
    assert.ok(wide[0] < square[0], 'a wider viewport must compress x');
    assert.equal(wide[5], square[5], 'y scale must be aspect-independent');
  });

  it('lookAt() puts the eye at the origin of the view space', () => {
    const m = mat4.lookAt([10, 20, 30], [0, 0, 0], [0, 1, 0]);
    const at = transform(m, [10, 20, 30]);
    for (const c of at) assert.ok(Math.abs(c) < 1e-4, `eye should map to origin, got ${at}`);
  });

  it('lookAt() puts the target down -Z (right-handed), never +Z', () => {
    const m = mat4.lookAt([0, 0, 10], [0, 0, 0], [0, 1, 0]);
    const t = transform(m, [0, 0, 0]);
    assert.ok(t[2] < 0, `target must be in front of the camera (-Z), got z=${t[2]}`);
    assert.ok(Math.abs(t[2] + 10) < 1e-4, 'target must be exactly the eye distance away');
  });

  it('lookAt() keeps world up on +Y of the view basis', () => {
    const m = mat4.lookAt([0, 0, 10], [0, 0, 0], [0, 1, 0]);
    const up = direction(m, [0, 1, 0]);
    assert.ok(Math.abs(up[1] - 1) < 1e-4, `world up must stay view-up, got ${up}`);
  });

  it('lookAt() survives a degenerate up vector parallel to the view axis', () => {
    // Cross product is ~0 here; the guard must not emit NaN into the matrix.
    const m = mat4.lookAt([0, 10, 0], [0, 0, 0], [0, 1, 0]);
    for (const v of m) assert.ok(Number.isFinite(v), 'degenerate up produced a non-finite matrix');
  });

  it('multiply() composes in proj*view order, which is not commutative', () => {
    const a = mat4.perspective(Math.PI / 3, 1.3, 0.5, 250);
    const b = mat4.lookAt([3, 4, 5], [1, 0, -2], [0, 1, 0]);
    const ab = nums(mat4.multiply(a, b));
    const ba = nums(mat4.multiply(b, a));
    assert.notDeepEqual(ab, ba, 'a commuting fixture cannot detect an operand swap');

    // Reference product, computed independently of the implementation.
    const ref: number[] = [];
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + i] * b[j * 4 + k];
        ref[j * 4 + i] = s;
      }
    }
    for (let i = 0; i < 16; i++) {
      assert.ok(Math.abs(ab[i] - ref[i]) < 1e-4, `element ${i}: ${ab[i]} != ${ref[i]}`);
    }
  });

  it('multiply() by the identity is a no-op on both sides', () => {
    const a = mat4.lookAt([1, 2, 3], [0, 0, 0], [0, 1, 0]);
    const id = mat4.create();
    assert.deepEqual(Array.from(mat4.multiply(a, id)), Array.from(a));
    assert.deepEqual(Array.from(mat4.multiply(id, a)), Array.from(a));
  });

  it('invert() returns the true inverse of a non-trivial matrix', () => {
    const a = mat4.multiply(
      mat4.perspective(Math.PI / 5, 1.7, 0.25, 400),
      mat4.lookAt([7, -3, 11], [2, 1, 0], [0, 1, 0]),
    );
    const p = nums(mat4.multiply(a, mat4.invert(a)));
    const id = nums(mat4.create());
    for (let i = 0; i < 16; i++) {
      assert.ok(Math.abs(p[i] - id[i]) < 1e-3, `A·A⁻¹ element ${i} = ${p[i]}, want ${id[i]}`);
    }
  });

  it('invert() returns all zeros for a singular matrix instead of NaN', () => {
    const singular = new Float32Array(16); // det === 0
    const m = nums(mat4.invert(singular));
    assert.deepEqual(m, new Array(16).fill(0));
  });

  it('transpose() swaps rows and columns and is its own inverse', () => {
    const a = new Float32Array(Array.from({ length: 16 }, (_, i) => i + 1));
    const t = mat4.transpose(a);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        assert.equal(t[c * 4 + r], a[r * 4 + c], `element (${r},${c}) was not transposed`);
      }
    }
    assert.deepEqual(Array.from(mat4.transpose(t)), Array.from(a));
  });
});

function transform(m: Float32Array, p: readonly number[]): number[] {
  return [0, 1, 2].map((i) => m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i]);
}
function direction(m: Float32Array, v: readonly number[]): number[] {
  return [0, 1, 2].map((i) => m[i] * v[0] + m[4 + i] * v[1] + m[8 + i] * v[2]);
}

// ── 2. Geometry bookkeeping ─────────────────────────────────────────────────

describe('viewer blob — chunk indexing', () => {
  it('is browser-free', () => assertBrowserFree('getChunkIndex'));

  const load = (positions: Float32Array[], indices: Uint32Array[]) =>
    loadDecls(['getChunkIndex'], { positions, indices }).getChunkIndex;

  // Three position chunks of 2, 3 and 1 vertices; cumulative 2, 5, 6.
  const positions = [new Float32Array(6), new Float32Array(9), new Float32Array(3)];
  const indices = [new Uint32Array(4), new Uint32Array(6)]; // cumulative 4, 10

  it('returns the first chunk that starts strictly after the boundary', () => {
    const getChunkIndex = load(positions, indices);
    // 0 verts uploaded -> resume at chunk 0; 2 uploaded -> chunk 1 (not 0).
    assert.equal(getChunkIndex(0), 0);
    assert.equal(getChunkIndex(2), 1, 'an exact chunk boundary must not re-include that chunk');
    assert.equal(getChunkIndex(5), 2, 'an exact chunk boundary must not re-include that chunk');
  });

  it('discriminates every boundary individually, not just one', () => {
    const getChunkIndex = load(positions, indices);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((n) => getChunkIndex(n)), [0, 0, 1, 1, 1, 2, 3]);
  });

  it('returns arr.length once everything is uploaded, yielding an empty slice', () => {
    const getChunkIndex = load(positions, indices);
    assert.equal(getChunkIndex(6), positions.length);
    assert.equal(getChunkIndex(999), positions.length);
  });

  it('divides by 3 for positions but by 1 for indices', () => {
    const getChunkIndex = load(positions, indices);
    // Same numeric argument, different divisor: 4 is a boundary in indices
    // (chunk 0 holds 4 indices) but mid-chunk in positions.
    assert.equal(getChunkIndex(4, false), 1);
    assert.equal(getChunkIndex(4, true), 1);
    assert.equal(getChunkIndex(3, true), 0, 'index counts must not be divided by 3');
    assert.equal(getChunkIndex(9, true), 1);
    assert.equal(getChunkIndex(10, true), indices.length);
  });

  it('defaults to the positions array when isIndices is omitted', () => {
    const getChunkIndex = load(positions, indices);
    assert.equal(getChunkIndex(9), positions.length, 'omitting the flag must select positions');
  });
});

describe('viewer blob — typed-array merging', () => {
  it('is browser-free', () => {
    assertBrowserFree('mergeFloat32');
    assertBrowserFree('mergeUint32');
  });

  const { mergeFloat32, mergeUint32 } = loadDecls(['mergeFloat32', 'mergeUint32']);

  it('concatenates chunks in order at the right offsets', () => {
    const out = mergeFloat32([new Float32Array([1, 2]), new Float32Array([3, 4, 5])], 5);
    assert.ok(out instanceof Float32Array, 'merged positions must stay Float32Array');
    assert.deepEqual(Array.from(out), [1, 2, 3, 4, 5]);
  });

  it('preserves chunk order — a reversed input must not compare equal', () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([3, 4]);
    assert.deepEqual(Array.from(mergeFloat32([a, b], 4)), [1, 2, 3, 4]);
    assert.deepEqual(Array.from(mergeFloat32([b, a], 4)), [3, 4, 1, 2]);
  });

  it('zero-fills the tail when totalLen exceeds the input', () => {
    assert.deepEqual(Array.from(mergeFloat32([new Float32Array([9])], 3)), [9, 0, 0]);
  });

  it('mergeUint32 produces a Uint32Array, not a float one', () => {
    const out = mergeUint32([new Uint32Array([7]), new Uint32Array([8, 9])], 3);
    assert.ok(out instanceof Uint32Array, 'index buffers must stay integral');
    assert.deepEqual(Array.from(out), [7, 8, 9]);
  });
});

describe('viewer blob — foldOrigin', () => {
  it('is browser-free', () => assertBrowserFree('foldOrigin'));

  const { foldOrigin } = loadDecls(['foldOrigin']);

  it('adds the per-element local-frame origin onto every vertex (#2261)', () => {
    // wasm's local-frame storage (default ON) stores positions relative to a
    // per-mesh origin: world = origin + position. Two vertices of one mesh,
    // offset by a non-zero origin (e.g. a column 42m from the model origin).
    const positions = new Float32Array([0.4, -12.7, -0.4, -0.4, 12.7, 0.4]);
    const origin = [-0.4, 42.78, -0.55];
    const out = foldOrigin(positions, origin);
    assert.deepEqual(nums(out).map(round), [0, 30.08, -0.95, -0.8, 55.48, -0.15]);
  });

  it('is a no-op when origin is [0,0,0] (positions already absolute)', () => {
    const positions = new Float32Array([1, 2, 3]);
    const out = foldOrigin(positions, [0, 0, 0]);
    assert.equal(out, positions, 'must return the same array, not a needless copy');
  });

  it('is a no-op when origin is missing (older wasm bundle)', () => {
    const positions = new Float32Array([1, 2, 3]);
    const out = foldOrigin(positions, undefined);
    assert.equal(out, positions);
  });

  it('does not mutate the input array', () => {
    const positions = new Float32Array([1, 2, 3]);
    foldOrigin(positions, [10, 20, 30]);
    assert.deepEqual(Array.from(positions), [1, 2, 3]);
  });

  it('is applied at both mesh-ingestion call sites, not just one', () => {
    // Regression guard: this bug's fix is easy to apply at the main load path
    // and silently miss the /api/create (addGeometry) live-streaming path, or
    // vice versa. Both onBatch callbacks must route positions through
    // foldOrigin rather than reading m.positions directly.
    const occurrences = SCRIPT.match(/positions:\s*foldOrigin\(m\.positions,\s*m\.origin\)/g) ?? [];
    assert.equal(occurrences.length, 2, 'both onBatch callbacks must fold m.origin into m.positions');
  });
});

describe('viewer blob — bounds', () => {
  it('is browser-free', () => {
    assertBrowserFree('computeEntityBounds');
    assertBrowserFree('updateBounds');
  });

  const { computeEntityBounds } = loadDecls(['computeEntityBounds']);

  it('folds min and max over every axis independently', () => {
    const pos = new Float32Array([1, -5, 3, -2, 7, 0, 4, 1, -6]);
    assert.deepEqual(computeEntityBounds(pos, 0, 3), { min: [-2, -5, -6], max: [4, 7, 3] });
  });

  it('honours startVert so a mesh reads only its own slice', () => {
    // First vertex is a wild outlier that must be excluded when skipped.
    const pos = new Float32Array([999, 999, 999, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(computeEntityBounds(pos, 1, 2), { min: [1, 2, 3], max: [4, 5, 6] });
    assert.deepEqual(computeEntityBounds(pos, 0, 2).max, [999, 999, 999]);
  });

  it('honours vertCount so it stops before the next mesh', () => {
    const pos = new Float32Array([1, 2, 3, 4, 5, 6, 999, 999, 999]);
    assert.deepEqual(computeEntityBounds(pos, 0, 2).max, [4, 5, 6]);
  });

  it('returns an inverted (empty) box for an empty mesh', () => {
    const { min, max } = computeEntityBounds(new Float32Array(0), 0, 0);
    assert.deepEqual(min, [Infinity, Infinity, Infinity]);
    assert.deepEqual(max, [-Infinity, -Infinity, -Infinity]);
  });

  it('updateBounds accumulates across calls into the shared model box', () => {
    const ctx = loadDecls(['updateBounds'], {
      boundsMin: [Infinity, Infinity, Infinity],
      boundsMax: [-Infinity, -Infinity, -Infinity],
    });
    ctx.updateBounds(new Float32Array([0, 0, 0]));
    ctx.updateBounds(new Float32Array([-1, 5, 2, 3, -4, 1]));
    assert.deepEqual(ctx.boundsMin, [-1, -4, 0]);
    assert.deepEqual(ctx.boundsMax, [3, 5, 2]);
  });
});

describe('viewer blob — getEntityBoundsForFilter', () => {
  it('is browser-free', () => assertBrowserFree('getEntityBoundsForFilter'));

  const entity = (id: number, min: number[], max: number[], ifcType = 'IfcWall') =>
    [id, { boundsMin: min, boundsMax: max, ifcType }] as const;

  const load = (entries: readonly (readonly [number, unknown])[]) =>
    loadDecls(['getEntityBoundsForFilter'], { entityMap: new Map(entries as any) })
      .getEntityBoundsForFilter;

  it('unions only the matching entities', () => {
    const fn = load([
      entity(1, [0, 0, 0], [1, 1, 1]),
      entity(2, [5, 5, 5], [6, 6, 6]),
      entity(3, [-100, -100, -100], [100, 100, 100], 'IfcSlab'),
    ]);
    assert.deepEqual(fn((_: number, i: any) => i.ifcType === 'IfcWall'), {
      min: [0, 0, 0],
      max: [6, 6, 6],
    });
  });

  it('passes the entity id to the filter, not just the info', () => {
    const fn = load([entity(1, [0, 0, 0], [1, 1, 1]), entity(2, [5, 5, 5], [6, 6, 6])]);
    assert.deepEqual(fn((eid: number) => eid === 2), { min: [5, 5, 5], max: [6, 6, 6] });
  });

  it('returns null when nothing matches, rather than an infinite box', () => {
    const fn = load([entity(1, [0, 0, 0], [1, 1, 1])]);
    assert.equal(fn(() => false), null);
  });

  it('returns null for an empty model', () => {
    assert.equal(load([])(() => true), null);
  });
});

// ── 3. Colour resolution ────────────────────────────────────────────────────

describe('viewer blob — resolveColor', () => {
  it('is browser-free', () => assertBrowserFree('resolveColor'));

  const { resolveColor, NAMED_COLORS } = loadDecls(['NAMED_COLORS', 'resolveColor']);

  it('resolves every documented colour name to its own distinct RGBA', () => {
    const names = Object.keys(NAMED_COLORS);
    assert.ok(names.length >= 10, `expected the full palette, got ${names.length}`);
    const seen = new Set<string>();
    for (const name of names) {
      const rgba = resolveColor(name);
      assert.deepEqual(rgba, NAMED_COLORS[name], `${name} must resolve to its palette entry`);
      assert.equal(rgba.length, 4, `${name} must be RGBA`);
      seen.add(JSON.stringify(rgba));
    }
    assert.equal(seen.size, names.length, 'palette entries must be distinct');
  });

  it('is case-insensitive on names', () => {
    assert.deepEqual(resolveColor('BLUE'), NAMED_COLORS.blue);
    assert.deepEqual(resolveColor('Blue'), NAMED_COLORS.blue);
  });

  it('falls back to red for an unknown name', () => {
    assert.deepEqual(resolveColor('chartreuse'), [1, 0, 0, 1]);
    assert.deepEqual(resolveColor(''), [1, 0, 0, 1]);
  });

  it('passes an explicit array through untouched', () => {
    const rgba = [0.1, 0.2, 0.3, 0.4];
    assert.equal(resolveColor(rgba), rgba, 'arrays must not be copied or re-resolved');
  });

  it('falls back to red for null, undefined and objects', () => {
    for (const bad of [null, undefined, 42, { r: 1 }]) {
      assert.deepEqual(resolveColor(bad), [1, 0, 0, 1], `unexpected result for ${String(bad)}`);
    }
  });
});

describe('viewer blob — matchesType', () => {
  it('is browser-free', () => assertBrowserFree('matchesType'));

  const { matchesType } = loadDecls(['matchesType']);

  it('matches an exact IFC EXPRESS name', () => {
    assert.equal(matchesType({ ifcType: 'IfcWall' }, 'IfcWall'), true);
  });

  it('rejects the short name, a substring and a differing case', () => {
    assert.equal(matchesType({ ifcType: 'IfcWall' }, 'Wall'), false);
    assert.equal(matchesType({ ifcType: 'IfcWallStandardCase' }, 'IfcWall'), false);
    assert.equal(matchesType({ ifcType: 'IfcWall' }, 'ifcwall'), false);
    assert.equal(matchesType({ ifcType: 'IfcWall' }, 'IfcSlab'), false);
  });

  it('rejects an undefined query type instead of matching everything', () => {
    assert.equal(matchesType({ ifcType: 'IfcWall' }, undefined), false);
  });
});

describe('viewer blob — applyColorOverrides', () => {
  it('is browser-free', () => assertBrowserFree('applyColorOverrides'));

  const build = (entityMap: Map<number, unknown>, colorOverrides: Map<number, number[]>) =>
    loadDecls(['applyColorOverrides'], { entityMap, colorOverrides }).applyColorOverrides;

  const info = (segments: { vertexStart: number; vertexCount: number }[]) => ({ segments });

  it('writes the override over exactly the entity vertex range', () => {
    const apply = build(
      new Map([[1, info([{ vertexStart: 1, vertexCount: 2 }])]]),
      new Map([[1, [0.5, 0.6, 0.7, 0.8]]]),
    );
    const col = new Float32Array(4 * 4); // 4 vertices, RGBA
    apply(col);
    assert.deepEqual(Array.from(col.slice(0, 4)), [0, 0, 0, 0], 'vertex 0 must be untouched');
    assert.deepEqual(Array.from(col.slice(4, 8)).map(round), [0.5, 0.6, 0.7, 0.8]);
    assert.deepEqual(Array.from(col.slice(8, 12)).map(round), [0.5, 0.6, 0.7, 0.8]);
    assert.deepEqual(Array.from(col.slice(12, 16)), [0, 0, 0, 0], 'vertex 3 must be untouched');
  });

  it('covers every segment of a multi-segment entity', () => {
    const apply = build(
      new Map([[
        1,
        info([{ vertexStart: 0, vertexCount: 1 }, { vertexStart: 2, vertexCount: 1 }]),
      ]]),
      new Map([[1, [1, 1, 1, 1]]]),
    );
    const col = new Float32Array(3 * 4);
    apply(col);
    assert.deepEqual(Array.from(col.slice(0, 4)), [1, 1, 1, 1]);
    assert.deepEqual(Array.from(col.slice(4, 8)), [0, 0, 0, 0], 'gap segment must stay default');
    assert.deepEqual(Array.from(col.slice(8, 12)), [1, 1, 1, 1]);
  });

  it('skips overrides for entities that are not loaded', () => {
    const apply = build(new Map(), new Map([[99, [1, 1, 1, 1]]]));
    const col = new Float32Array(4);
    apply(col);
    assert.deepEqual(Array.from(col), [0, 0, 0, 0]);
  });
});

// ── 4. GPU pick-colour codec ────────────────────────────────────────────────

/**
 * The pick pass encodes a dense index into the R/G/B of a pixel and decodes it
 * on click. Encoder and decoder live inline in two browser-bound functions, so
 * the exact shipped expressions are lifted by anchor and round-tripped here —
 * a mismatch between them silently breaks picking for high entity counts.
 */
describe('viewer blob — pick index codec', () => {
  const encodeSrc = extractBetween('const pr = ', 'for (let i = 0; i < vCount; i++) {');
  const decodeSrc = extractBetween('const pickIndex = ', ';\n  const pickedId');

  // Encode to floats exactly as the vertex buffer does, quantise through an
  // 8-bit-per-channel framebuffer read, then decode exactly as the click does.
  const roundTrip: (pickIndex: number) => number = new Function(
    'pickIndex',
    `const pr = ${encodeSrc.trim()}
     const pixel = [Math.round(pr * 255), Math.round(pg * 255), Math.round(pb * 255)];
     return (${decodeSrc.trim()});`,
  ) as (pickIndex: number) => number;

  it('lifted the real expressions, not empty strings', () => {
    assert.match(encodeSrc, />>\s*16/);
    assert.match(decodeSrc, /pixel\[0\]/);
  });

  it('round-trips 0, which encodes "no entity"', () => {
    assert.equal(roundTrip(0), 0);
  });

  it('round-trips indices across all three colour channels', () => {
    for (const n of [1, 2, 254, 255, 256, 257, 65535, 65536, 65537, 1e6, 0xfffffe]) {
      assert.equal(roundTrip(n), n, `pick index ${n} did not survive the framebuffer`);
    }
  });

  it('round-trips the largest representable index (2^24 - 1)', () => {
    const PICK_INDEX_MAX = 0xffffff;
    assert.match(extractDecl('PICK_INDEX_MAX'), /0xFFFFFF/);
    assert.equal(roundTrip(PICK_INDEX_MAX), PICK_INDEX_MAX);
  });

  it('separates adjacent indices — no two neighbours collide', () => {
    const seen = new Set<number>();
    for (const n of [65534, 65535, 65536, 65537]) seen.add(roundTrip(n));
    assert.equal(seen.size, 4, 'adjacent pick indices must decode distinctly');
  });

  it('the allocator stops before the codec overflows', () => {
    // nextPickIndex is only incremented while strictly below PICK_INDEX_MAX,
    // so no allocated index can exceed what 24 bits can carry.
    const src = SCRIPT;
    assert.ok(
      src.includes('if (nextPickIndex < PICK_INDEX_MAX)'),
      'the pick allocator no longer bounds itself by PICK_INDEX_MAX',
    );
    assert.ok(src.includes('pickIndex = 0;'), 'exhaustion must fall back to "no entity"');
  });
});

// ── 5. Command handling ─────────────────────────────────────────────────────

/**
 * `handleCommand` is the CLI→browser control surface. It is not browser-free —
 * it calls into GL upload and DOM status seams — so those *specific* seams are
 * injected as recording stubs while every pure collaborator (`resolveColor`,
 * `matchesType`, `getEntityBoundsForFilter`, the palettes) is the real lifted
 * source. No GL context and no DOM are simulated; the assertions are all on
 * plain state the command mutates.
 */
function makeViewer(
  entities: readonly (readonly [number, any])[] = [],
  opts: { boundsMin?: number[]; boundsMax?: number[] } = {},
) {
  const calls: string[] = [];
  const flyToCalls: { target: number[]; dist: number }[] = [];
  const parseCalls: { content: unknown; opts: any }[] = [];
  const addedBatches: unknown[][] = [];
  const scope: Record<string, any> = {
    entityMap: new Map(entities as any),
    colorOverrides: new Map<number, number[]>(),
    createdEntityIds: new Set<number>(),
    boundsMin: opts.boundsMin ?? [0, 0, 0],
    boundsMax: opts.boundsMax ?? [10, 10, 10],
    sectionEnabled: false,
    sectionPlane: [0, 1, 0, 0],
    camTarget: [0, 0, 0],
    camDist: 50,
    camTheta: 0,
    camPhi: 0,
    camThetaTarget: 0,
    camPhiTarget: 0,
    camVelTheta: 0,
    camVelPhi: 0,
    camAnimating: false,
    camAnimStart: 0,
    camAnimDuration: 0,
    camAnimFrom: null,
    camAnimTo: null,
    totalTriangles: 0,
    wasmApi: null,
    nextIdNamespace: 0,
    // Seam: the wasm pre-pass parser. Capture the options the command built so
    // a test can drive the real onBatch callback with a synthetic mesh.
    parseMeshesViaPrePass: (_api: unknown, content: unknown, opts: any) => {
      parseCalls.push({ content, opts });
      return Promise.resolve();
    },
    addMeshBatch: (batch: unknown[]) => addedBatches.push(batch),
    // Seams: GPU upload, status text and camera animation.
    refreshColors: () => calls.push('refreshColors'),
    markColorDirty: (eid: number) => calls.push(`markColorDirty:${eid}`),
    markAllColorsDirty: () => calls.push('markAllColorsDirty'),
    showCmdLog: (a: string) => calls.push(`showCmdLog:${a}`),
    fitCamera: () => calls.push('fitCamera'),
    flyTo: (target: number[], dist: number) => flyToCalls.push({ target, dist }),
    document: { getElementById: () => ({ textContent: '' }) },
  };
  const ctx = loadDecls(
    [
      'NAMED_COLORS',
      'resolveColor',
      'matchesType',
      'getEntityBoundsForFilter',
      'STOREY_PALETTE',
      'ID_NAMESPACE_SIZE',
      'foldOrigin',
      'handleCommand',
    ],
    scope,
  );
  return {
    ctx,
    calls,
    flyToCalls,
    parseCalls,
    addedBatches,
    run: (cmd: unknown) => ctx.handleCommand(cmd),
  };
}

const wall = (id: number, y = 0, ifcType = 'IfcWall') =>
  [
    id,
    {
      ifcType,
      defaultColor: [0.8, 0.8, 0.8, 1],
      boundsMin: [0, y, 0],
      boundsMax: [1, y + 1, 1],
      segments: [{ vertexStart: 0, vertexCount: 1, indexStart: 0, indexCount: 3 }],
    },
  ] as const;

describe('viewer blob — handleCommand: colour commands', () => {
  it('colorize sets the named colour on matching types only', () => {
    const v = makeViewer([wall(1), wall(2, 0, 'IfcSlab'), wall(3)]);
    v.run({ action: 'colorize', type: 'IfcWall', color: 'blue' });
    assert.deepEqual([...v.ctx.colorOverrides.keys()].sort(), [1, 3]);
    assert.deepEqual(v.ctx.colorOverrides.get(1), v.ctx.NAMED_COLORS.blue);
    assert.ok(v.calls.includes('refreshColors'), 'the GPU buffer must be refreshed');
    assert.ok(v.calls.includes('markColorDirty:1'), 'only changed entities may be marked dirty');
    assert.ok(!v.calls.includes('markColorDirty:2'));
  });

  it('colorize with an unknown type changes nothing', () => {
    const v = makeViewer([wall(1)]);
    v.run({ action: 'colorize', type: 'IfcDoor', color: 'blue' });
    assert.equal(v.ctx.colorOverrides.size, 0);
  });

  it('isolate dims non-matching entities and clears overrides on matches', () => {
    const v = makeViewer([wall(1), wall(2, 0, 'IfcSlab')]);
    v.ctx.colorOverrides.set(1, [1, 0, 0, 1]);
    v.run({ action: 'isolate', type: 'IfcWall' });
    assert.equal(v.ctx.colorOverrides.has(1), false, 'the isolated entity must show its own colour');
    assert.deepEqual(v.ctx.colorOverrides.get(2), [0.3, 0.3, 0.35, 0.06]);
  });

  it('isolate accepts a types array, keeping every listed type', () => {
    const v = makeViewer([wall(1), wall(2, 0, 'IfcSlab'), wall(3, 0, 'IfcDoor')]);
    v.run({ action: 'isolate', types: ['IfcWall', 'IfcSlab'] });
    assert.equal(v.ctx.colorOverrides.has(1), false);
    assert.equal(v.ctx.colorOverrides.has(2), false);
    assert.ok(v.ctx.colorOverrides.has(3), 'unlisted types must be dimmed');
  });

  it('xray keeps the default RGB and replaces only alpha', () => {
    const v = makeViewer([wall(1)]);
    v.run({ action: 'xray', type: 'IfcWall', opacity: 0.42 });
    assert.deepEqual(v.ctx.colorOverrides.get(1), [0.8, 0.8, 0.8, 0.42]);
  });

  it('xray defaults to 0.15 opacity but honours an explicit 0', () => {
    const a = makeViewer([wall(1)]);
    a.run({ action: 'xray', type: 'IfcWall' });
    assert.equal(a.ctx.colorOverrides.get(1)[3], 0.15);

    const b = makeViewer([wall(1)]);
    b.run({ action: 'xray', type: 'IfcWall', opacity: 0 });
    assert.equal(b.ctx.colorOverrides.get(1)[3], 0, '?? must not treat 0 as missing');
  });

  it('hideEntities makes the listed ids fully transparent', () => {
    const v = makeViewer([wall(1), wall(2)]);
    v.run({ action: 'hideEntities', ids: [2] });
    assert.deepEqual(v.ctx.colorOverrides.get(2), [0, 0, 0, 0]);
    assert.equal(v.ctx.colorOverrides.has(1), false);
  });

  it('showEntities and resetColorEntities drop the override for the listed ids', () => {
    for (const action of ['showEntities', 'resetColorEntities']) {
      const v = makeViewer([wall(1), wall(2)]);
      v.ctx.colorOverrides.set(1, [0, 0, 0, 0]);
      v.ctx.colorOverrides.set(2, [0, 0, 0, 0]);
      v.run({ action, ids: [1] });
      assert.equal(v.ctx.colorOverrides.has(1), false, `${action} must clear id 1`);
      assert.equal(v.ctx.colorOverrides.has(2), true, `${action} must leave id 2 alone`);
    }
  });

  it('isolateEntities dims by id, not by type', () => {
    const v = makeViewer([wall(1), wall(2), wall(3)]);
    v.run({ action: 'isolateEntities', ids: [2] });
    assert.deepEqual(v.ctx.colorOverrides.get(1), [0.3, 0.3, 0.35, 0.06]);
    assert.equal(v.ctx.colorOverrides.has(2), false);
    assert.deepEqual(v.ctx.colorOverrides.get(3), [0.3, 0.3, 0.35, 0.06]);
  });

  it('highlight paints amber and tolerates a missing ids list', () => {
    const v = makeViewer([wall(1)]);
    v.run({ action: 'highlight', ids: [1] });
    assert.deepEqual(v.ctx.colorOverrides.get(1), [1, 0.9, 0, 1]);

    const empty = makeViewer([wall(1)]);
    assert.doesNotThrow(() => empty.run({ action: 'highlight' }));
    assert.equal(empty.ctx.colorOverrides.size, 0);
  });

  it('showall clears every override and forces a full rebuild', () => {
    const v = makeViewer([wall(1)]);
    v.ctx.colorOverrides.set(1, [1, 0, 0, 1]);
    v.run({ action: 'showall' });
    assert.equal(v.ctx.colorOverrides.size, 0);
    assert.ok(v.calls.includes('markAllColorsDirty'), 'a bulk clear needs a full rebuild');
  });

  it('reset also clears the section and refits the camera', () => {
    const v = makeViewer([wall(1)]);
    v.ctx.colorOverrides.set(1, [1, 0, 0, 1]);
    v.run({ action: 'section', axis: 'y', position: 5 });
    v.run({ action: 'reset' });
    assert.equal(v.ctx.colorOverrides.size, 0);
    assert.equal(v.ctx.sectionEnabled, false);
    assert.ok(v.calls.includes('fitCamera'));
  });
});

describe('viewer blob — handleCommand: section plane', () => {
  const bounds = { boundsMin: [-10, 0, 2], boundsMax: [10, 20, 6] };

  it('enables the plane and selects the axis normal', () => {
    for (const [axis, normal] of [
      ['x', [1, 0, 0]],
      ['y', [0, 1, 0]],
      ['z', [0, 0, 1]],
    ] as const) {
      const v = makeViewer([], bounds);
      v.run({ action: 'section', axis, position: 1 });
      assert.equal(v.ctx.sectionEnabled, true);
      assert.deepEqual(v.ctx.sectionPlane.slice(0, 3), normal, `axis ${axis}`);
      assert.equal(v.ctx.sectionPlane[3], 1, `axis ${axis} position`);
    }
  });

  it('defaults to the Y axis when the axis is missing', () => {
    const v = makeViewer([], bounds);
    v.run({ action: 'section', position: 3 });
    assert.deepEqual(v.ctx.sectionPlane, [0, 1, 0, 3]);
  });

  it('pins the current behaviour for an unrecognised axis name', () => {
    // The server's /api/command allowlist validates `action` but not `axis`,
    // so an arbitrary axis reaches here. The *position* falls back to the Y
    // extent while the *normal* stays all-zero — an asymmetry, recorded here as
    // observed behaviour rather than changed. A zero normal makes the clip test
    // degenerate, so the section neither cuts nor is visibly rejected.
    const v = makeViewer([], bounds);
    v.run({ action: 'section', axis: 'w', position: 3 });
    assert.equal(v.ctx.sectionEnabled, true);
    assert.deepEqual(v.ctx.sectionPlane, [0, 0, 0, 3]);
  });

  it('accepts an uppercase axis name', () => {
    const v = makeViewer([], bounds);
    v.run({ action: 'section', axis: 'X', position: 4 });
    assert.deepEqual(v.ctx.sectionPlane, [1, 0, 0, 4]);
  });

  it('centres on the axis midpoint for "center" and for a missing position', () => {
    for (const position of ['center', undefined]) {
      const v = makeViewer([], bounds);
      v.run({ action: 'section', axis: 'x', position });
      assert.equal(v.ctx.sectionPlane[3], 0, `x midpoint for ${String(position)}`);
      const w = makeViewer([], bounds);
      w.run({ action: 'section', axis: 'z', position });
      assert.equal(w.ctx.sectionPlane[3], 4, `z midpoint for ${String(position)}`);
    }
  });

  it('interpolates percentage positions across that axis extent', () => {
    const cases: [string, number][] = [
      ['0%', 0],
      ['25%', 5],
      ['50%', 10],
      ['100%', 20],
    ];
    for (const [pct, want] of cases) {
      const v = makeViewer([], bounds);
      v.run({ action: 'section', axis: 'y', position: pct });
      assert.equal(v.ctx.sectionPlane[3], want, `${pct} on y`);
    }
  });

  it('anchors percentages to the axis minimum, not to zero', () => {
    const v = makeViewer([], bounds);
    v.run({ action: 'section', axis: 'z', position: '50%' }); // z spans 2..6
    assert.equal(v.ctx.sectionPlane[3], 4, 'must be min + 50% of extent, not 50% of max');
  });

  it('treats a bare number as an absolute world coordinate', () => {
    const v = makeViewer([], bounds);
    v.run({ action: 'section', axis: 'y', position: 7.5 });
    assert.equal(v.ctx.sectionPlane[3], 7.5);
  });

  it('coerces a numeric string and falls back to 0 for nonsense', () => {
    const num = makeViewer([], bounds);
    num.run({ action: 'section', axis: 'y', position: '7.5' });
    assert.equal(num.ctx.sectionPlane[3], 7.5);

    const junk = makeViewer([], bounds);
    junk.run({ action: 'section', axis: 'y', position: 'banana' });
    assert.equal(junk.ctx.sectionPlane[3], 0);
  });

  it('accepts the nested { section: { axis, position } } form identically', () => {
    const flat = makeViewer([], bounds);
    flat.run({ action: 'section', axis: 'x', position: '25%' });
    const nested = makeViewer([], bounds);
    nested.run({ action: 'section', section: { axis: 'x', position: '25%' } });
    assert.deepEqual(nested.ctx.sectionPlane, flat.ctx.sectionPlane);
    assert.equal(nested.ctx.sectionPlane[3], -5);
  });

  it('clearSection disables the plane without discarding it', () => {
    const v = makeViewer([], bounds);
    v.run({ action: 'section', axis: 'y', position: 3 });
    v.run({ action: 'clearSection' });
    assert.equal(v.ctx.sectionEnabled, false);
    assert.deepEqual(v.ctx.sectionPlane, [0, 1, 0, 3]);
  });
});

/** A zero-height entity, so its storey bin follows exactly from `y`. */
const atHeight = (id: number, y: number) =>
  [id, { ifcType: 'IfcWall', boundsMin: [0, y, 0], boundsMax: [1, y, 1], segments: [] }] as const;

describe('viewer blob — handleCommand: colorByStorey', () => {
  it('gives entities in the same Y bin the same colour and different bins different colours', () => {
    // 0..20m tall model -> targetStoreys = 7, binSize ≈ 2.857m.
    const v = makeViewer(
      [wall(1, 0), wall(2, 0.5), wall(3, 10), wall(4, 18)],
      { boundsMin: [0, 0, 0], boundsMax: [10, 20, 10] },
    );
    v.run({ action: 'colorByStorey' });
    const c = (id: number) => JSON.stringify(v.ctx.colorOverrides.get(id));
    assert.equal(c(1), c(2), 'entities at the same height must share a storey colour');
    assert.notEqual(c(1), c(3), 'entities 10m apart must not share a storey colour');
    assert.notEqual(c(3), c(4));
  });

  it('assigns palette colours in ascending height order', () => {
    const v = makeViewer([wall(1, 18), wall(2, 0), wall(3, 9)], {
      boundsMin: [0, 0, 0],
      boundsMax: [10, 20, 10],
    });
    v.run({ action: 'colorByStorey' });
    const palette = v.ctx.STOREY_PALETTE;
    assert.deepEqual(v.ctx.colorOverrides.get(2), palette[0], 'lowest storey takes palette[0]');
    assert.deepEqual(v.ctx.colorOverrides.get(3), palette[1]);
    assert.deepEqual(v.ctx.colorOverrides.get(1), palette[2]);
  });

  it('cycles the palette rather than running out of colours', () => {
    const palette = makeViewer().ctx.STOREY_PALETTE;
    assert.equal(palette.length, 10);
    // 30m model -> 10 target storeys -> 3m bins -> 11 occupied bins (0..10).
    const entities = Array.from({ length: 11 }, (_, i) => atHeight(i + 1, i * 3));
    const v = makeViewer(entities, { boundsMin: [0, 0, 0], boundsMax: [10, 30, 10] });
    v.run({ action: 'colorByStorey' });
    for (let i = 1; i <= 11; i++) {
      assert.ok(v.ctx.colorOverrides.get(i), `entity ${i} must be coloured`);
    }
    assert.deepEqual(v.ctx.colorOverrides.get(10), palette[9], 'the 10th storey takes palette[9]');
    assert.deepEqual(v.ctx.colorOverrides.get(11), palette[0], 'the 11th storey must wrap');
  });

  it('caps the storey count at 10, so a tall model keeps broad bands', () => {
    // 60m model: uncapped this would target 20 storeys (3m bins) and split
    // these two entities apart; the cap gives 10 storeys (6m bins).
    const v = makeViewer(
      [atHeight(1, 0), atHeight(2, 4)],
      { boundsMin: [0, 0, 0], boundsMax: [10, 60, 10] },
    );
    v.run({ action: 'colorByStorey' });
    assert.deepEqual(
      v.ctx.colorOverrides.get(1),
      v.ctx.colorOverrides.get(2),
      'a 60m model must not be cut into more than 10 storeys',
    );
  });

  it('floors the storey count at 3, so a short model is still banded', () => {
    // 3m model: unfloored this would target 1 storey (one 3m bin) and colour
    // everything alike; the floor gives 3 storeys (1m bins).
    const v = makeViewer(
      [atHeight(1, 0), atHeight(2, 2)],
      { boundsMin: [0, 0, 0], boundsMax: [10, 3, 10] },
    );
    v.run({ action: 'colorByStorey' });
    assert.notDeepEqual(
      v.ctx.colorOverrides.get(1),
      v.ctx.colorOverrides.get(2),
      'a 3m model must still be cut into at least 3 storeys',
    );
  });

  it('survives a perfectly flat model without dividing by zero', () => {
    const v = makeViewer([wall(1, 0), wall(2, 0)], {
      boundsMin: [0, 0, 0],
      boundsMax: [10, 0, 10],
    });
    assert.doesNotThrow(() => v.run({ action: 'colorByStorey' }));
    for (const c of v.ctx.colorOverrides.values()) {
      for (const ch of c) assert.ok(Number.isFinite(ch), 'a flat model produced a non-finite colour');
    }
  });

  it('floors the BIN SIZE at 1cm, so a millimetre-thin model is one band', () => {
    // The flat-model test above cannot see the `Math.max(…, 0.01)` floor:
    // with a zero extent the bin key is NaN, every entity lands in that one
    // group, and the colours come out finite either way — dropping the floor
    // survives it (measured, round-four self-audit). A NEARLY flat model is
    // where the floor does work: a 1mm extent would otherwise give 0.33mm
    // bins and cut two entities 0.9mm apart into different storeys.
    const v = makeViewer(
      [atHeight(1, 0), atHeight(2, 0.0009)],
      { boundsMin: [0, 0, 0], boundsMax: [10, 0.001, 10] },
    );
    v.run({ action: 'colorByStorey' });
    assert.deepEqual(
      v.ctx.colorOverrides.get(1),
      v.ctx.colorOverrides.get(2),
      'a 1mm-tall model must not be banded into separate storeys',
    );
  });

  it('forces a full colour rebuild, not a per-entity one', () => {
    const v = makeViewer([wall(1, 0)]);
    v.run({ action: 'colorByStorey' });
    assert.ok(v.calls.includes('markAllColorsDirty'));
    assert.ok(!v.calls.some((c) => c.startsWith('markColorDirty:')));
  });
});

describe('viewer blob — handleCommand: camera and flyto', () => {
  it('setView maps every named preset to a distinct orientation', () => {
    const seen = new Map<string, string>();
    for (const view of ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso']) {
      const v = makeViewer();
      v.run({ action: 'setView', view });
      assert.ok(Number.isFinite(v.ctx.camTheta), `${view} produced a non-finite theta`);
      const key = `${v.ctx.camTheta.toFixed(6)}/${v.ctx.camPhi.toFixed(6)}`;
      assert.equal(seen.has(key), false, `${view} duplicates ${seen.get(key)}`);
      seen.set(key, view);
      assert.equal(v.ctx.camThetaTarget, v.ctx.camTheta, 'the smoothing target must be synced');
      assert.equal(v.ctx.camPhiTarget, v.ctx.camPhi, 'the smoothing target must be synced');
      assert.equal(v.ctx.camVelTheta, 0, 'inertia must be cancelled on a jump');
      assert.equal(v.ctx.camVelPhi, 0, 'inertia must be cancelled on a jump');
    }
    assert.equal(seen.size, 7);
  });

  it('setView top and bottom look down and up, not at the horizon', () => {
    const top = makeViewer();
    top.run({ action: 'setView', view: 'top' });
    const bottom = makeViewer();
    bottom.run({ action: 'setView', view: 'bottom' });
    assert.ok(top.ctx.camPhi < 0.2, `top must be near the +Y pole, got ${top.ctx.camPhi}`);
    assert.ok(bottom.ctx.camPhi > Math.PI - 0.2, `bottom must be near the -Y pole`);
  });

  it('setView accepts an uppercase name and ignores an unknown one', () => {
    const upper = makeViewer();
    upper.run({ action: 'setView', view: 'TOP' });
    assert.ok(upper.ctx.camPhi < 0.2, `TOP must resolve like top, got phi=${upper.ctx.camPhi}`);

    const unknown = makeViewer();
    unknown.run({ action: 'setView', view: 'sideways' });
    assert.equal(unknown.ctx.camAnimating, false, 'an unknown view must not start an animation');
    assert.equal(unknown.ctx.camTheta, 0);
  });

  it('setView tolerates a missing view name', () => {
    const v = makeViewer();
    assert.doesNotThrow(() => v.run({ action: 'setView' }));
    assert.equal(v.ctx.camAnimating, false);
  });

  it('flyto frames the centre of the matching type at a distance scaled to its size', () => {
    // Deliberately anisotropic AND off-origin. The old fixture was the unit
    // cube `wall(1, 0)`, whose extents are (1, 1, 1) and whose centre is
    // (0.5, 0.5, 0.5): `Math.max(...extents, 0.1) * 1.5` yields 1.5 there under
    // max, min, first-axis or a hardcoded 1, and the centre survives any axis
    // permutation. Extents (1, 3, 2) and centre (2.5, 0.5, 5) separate all of
    // those.
    const v = makeViewer([
      [
        1,
        {
          ifcType: 'IfcWall',
          defaultColor: [0.8, 0.8, 0.8, 1],
          boundsMin: [2, -1, 4],
          boundsMax: [3, 2, 6],
          segments: [{ vertexStart: 0, vertexCount: 1, indexStart: 0, indexCount: 3 }],
        },
      ],
      wall(2, 0, 'IfcSlab'),
    ]);
    v.run({ action: 'flyto', type: 'IfcWall' });
    assert.equal(v.flyToCalls.length, 1);
    assert.deepEqual(v.flyToCalls[0].target, [2.5, 0.5, 5]);
    // Extents are (1, 3, 2): the LARGEST, 3, times 1.5. The unmatched IfcSlab
    // at the origin would drag both numbers if the type filter leaked.
    assert.equal(v.flyToCalls[0].dist, 4.5, 'distance must scale with the largest dimension');
  });

  it('flyto by explicit ids overrides the type filter', () => {
    const v = makeViewer([wall(1, 0), wall(2, 100)]);
    v.run({ action: 'flyto', ids: [2] });
    assert.equal(v.flyToCalls[0].target[1], 100.5);
  });

  it('flyto does nothing when nothing matches', () => {
    const v = makeViewer([wall(1)]);
    v.run({ action: 'flyto', type: 'IfcDoor' });
    assert.equal(v.flyToCalls.length, 0, 'an empty selection must not move the camera');
  });

  it('flyto keeps a minimum distance for a degenerate (zero-size) selection', () => {
    const v = makeViewer([[1, { ifcType: 'IfcWall', boundsMin: [3, 3, 3], boundsMax: [3, 3, 3] }]]);
    v.run({ action: 'flyto', type: 'IfcWall' });
    assert.deepEqual(v.flyToCalls[0].target, [3, 3, 3]);
    // Pin the floor itself (0.1 * 1.5), not just "> 0": every extent here is 0,
    // so `dist > 0` holds for any positive floor and the 0.1 constant is inert.
    assert.ok(
      Math.abs(v.flyToCalls[0].dist - 0.15) < 1e-12,
      `a point selection must fall back to the 0.1 m floor, scaled by 1.5; got ${v.flyToCalls[0].dist}`
    );
  });
});

describe('viewer blob — handleCommand: lifecycle and unknown actions', () => {
  it('logs every action except the SSE handshake', () => {
    const v = makeViewer();
    v.run({ action: 'showall' });
    assert.ok(v.calls.includes('showCmdLog:showall'));
  });

  it('connected is a no-op that does not touch colours', () => {
    const v = makeViewer([wall(1)]);
    v.ctx.colorOverrides.set(1, [1, 0, 0, 1]);
    v.run({ action: 'connected' });
    assert.equal(v.ctx.colorOverrides.size, 1, 'the handshake must not reset the view');
    assert.ok(!v.calls.includes('refreshColors'));
  });

  it('an unknown action is ignored rather than throwing', () => {
    const v = makeViewer([wall(1)]);
    assert.doesNotThrow(() => v.run({ action: 'definitelyNotACommand' }));
    assert.equal(v.ctx.colorOverrides.size, 0);
  });

  it('removeCreated hides created geometry and empties the tracking set', () => {
    const v = makeViewer([wall(1), wall(2)]);
    v.ctx.createdEntityIds.add(2);
    v.run({ action: 'removeCreated' });
    assert.deepEqual(v.ctx.colorOverrides.get(2), [0, 0, 0, 0]);
    assert.equal(v.ctx.colorOverrides.has(1), false, 'loaded geometry must survive');
    assert.equal(v.ctx.createdEntityIds.size, 0);
  });

  it('addGeometry is a no-op until the wasm engine is ready', () => {
    const v = makeViewer();
    v.run({ action: 'addGeometry', ifcContent: 'ISO-10303-21;' });
    assert.equal(v.ctx.nextIdNamespace, 0, 'no namespace may be burned before wasm is ready');
    assert.equal(v.parseCalls.length, 0);
  });

  it('addGeometry is a no-op without content, even once wasm is ready', () => {
    const v = makeViewer();
    v.ctx.wasmApi = {};
    v.run({ action: 'addGeometry' });
    assert.equal(v.ctx.nextIdNamespace, 0);
    assert.equal(v.parseCalls.length, 0);
  });

  it('forwards the IFC payload to the parser', () => {
    const v = makeViewer();
    v.ctx.wasmApi = {};
    v.run({ action: 'addGeometry', ifcContent: 'ISO-10303-21;' });
    assert.equal(v.parseCalls.length, 1);
    assert.equal(v.parseCalls[0].content, 'ISO-10303-21;');
  });

  it('each addGeometry call offsets ids into a fresh, non-overlapping namespace', () => {
    const v = makeViewer();
    v.ctx.wasmApi = {};
    const mesh = () => ({
      expressId: 7,
      positions: new Float32Array(3),
      normals: new Float32Array(3),
      indices: new Uint32Array([0]),
      color: [1, 0, 0],
    });
    v.run({ action: 'addGeometry', ifcContent: 'a' });
    v.parseCalls[0].opts.onBatch([mesh()]);
    v.run({ action: 'addGeometry', ifcContent: 'b' });
    v.parseCalls[1].opts.onBatch([mesh()]);

    const ids = v.addedBatches.map((b: any) => b[0].expressId);
    assert.deepEqual(ids, [100007, 200007], 'the same source id must land in distinct namespaces');
    assert.ok(
      ids[1] - ids[0] >= v.ctx.ID_NAMESPACE_SIZE,
      'consecutive namespaces must not overlap',
    );
  });

  it('addGeometry labels, tracks and highlights the created entities', () => {
    const v = makeViewer();
    v.ctx.wasmApi = {};
    v.run({ action: 'addGeometry', ifcContent: 'a' });
    v.parseCalls[0].opts.onBatch([
      {
        expressId: 1,
        positions: new Float32Array(3),
        normals: new Float32Array(3),
        indices: new Uint32Array([0]),
        color: [0.1, 0.2, 0.3],
      },
      {
        expressId: 2,
        ifcType: 'IfcWall',
        positions: new Float32Array(3),
        normals: new Float32Array(3),
        indices: new Uint32Array([0]),
        color: [0.1, 0.2, 0.3, 0.5],
      },
    ]);
    const batch: any = v.addedBatches[0];
    assert.equal(batch[0].ifcType, 'Created', 'an untyped mesh must be labelled Created');
    assert.equal(batch[1].ifcType, 'IfcWall', 'an explicit type must survive');
    assert.deepEqual(batch[0].color, [0.1, 0.2, 0.3, 1], 'a missing alpha must default to opaque');
    assert.deepEqual(batch[1].color, [0.1, 0.2, 0.3, 0.5], 'an explicit alpha must survive');
    assert.deepEqual([...v.ctx.createdEntityIds], [100001, 100002]);
    assert.deepEqual(v.ctx.colorOverrides.get(100001), [0.2, 0.9, 0.4, 1]);
  });
});

// ── 9. Pick-info panel ──────────────────────────────────────────────────────

/**
 * `showPickInfo` touches `document`, so it is not browser-free — but the
 * `makeViewer` harness above already shows a `loadDecls` scope can carry a
 * `document` seam, so a fake one is all this needs. Asserting on the nodes the
 * function actually appends — rather than grepping the emitted source for
 * `.innerHTML` — is what makes the test survive a rewrite: any route that puts
 * markup in instead of text (`innerHTML`, `insertAdjacentHTML`) fails here,
 * because a text node is the only thing this fake document produces.
 */
function fakeDocument() {
  /** Every write that would have gone through the HTML parser in a browser. */
  const markupWrites: string[] = [];
  const make = () => {
    const node: any = {
      className: '',
      style: {} as Record<string, string>,
      children: [] as any[],
      _text: '',
      get textContent(): string {
        return node.children.length
          ? node.children.map((c: any) => c.textContent).join('')
          : node._text;
      },
      set textContent(v: string) {
        node.children = [];
        node._text = String(v);
      },
      // The two markup routes, recorded rather than parsed. A browser would
      // turn these into elements; here they are evidence the panel stopped
      // treating its input as text.
      set innerHTML(v: string) {
        markupWrites.push(String(v));
        node.children = [];
        node._text = '';
      },
      get innerHTML(): string {
        return markupWrites[markupWrites.length - 1] ?? '';
      },
      insertAdjacentHTML(_where: string, v: string) {
        markupWrites.push(String(v));
      },
      appendChild(child: any) {
        node._text = '';
        node.children.push(child);
        return child;
      },
    };
    return node;
  };
  const pickInfo = make();
  return {
    doc: {
      getElementById: (id: string) => (id === 'pick-info' ? pickInfo : null),
      createElement: make,
    },
    pickInfo,
    markupWrites,
  };
}

describe('viewer blob — showPickInfo builds the panel as text, not markup', () => {
  const renderPick = (eid: number, info: Record<string, unknown>) => {
    const { doc, pickInfo, markupWrites } = fakeDocument();
    loadDecls(['showPickInfo'], {
      entityMap: new Map<number, unknown>([[eid, info]]),
      document: doc,
    }).showPickInfo(eid);
    return { el: pickInfo, markupWrites };
  };

  it('appends one text-only div per row', () => {
    const { el, markupWrites } = renderPick(7, { ifcType: 'IfcWall', indexCount: 9 });
    assert.deepEqual(
      el.children.map((c: any) => [c.className, c.textContent]),
      [
        ['label', 'Entity #7'],
        ['value', 'IfcWall'],
        ['label', 'Triangles'],
        ['value', '3'],
      ],
    );
    assert.deepEqual(markupWrites, [], 'no row may be written through the HTML parser');
  });

  it('keeps an ifcType containing markup characters as literal text', () => {
    // Not reachable today: ifcType comes from the parser's IfcType::name(), a
    // closed set of "Ifc..." literals. This pins the property the rewrite
    // exists to guarantee — the panel renders whatever it is handed as text.
    const { el, markupWrites } = renderPick(1, {
      ifcType: '<img src=x onerror=alert(1)>&',
      indexCount: 3,
    });
    assert.deepEqual(
      markupWrites,
      [],
      'the type string must never reach innerHTML or insertAdjacentHTML',
    );
    const value = el.children[1];
    assert.equal(value.textContent, '<img src=x onerror=alert(1)>&');
    assert.equal(value.children.length, 0, 'the value must be a text node, never parsed markup');
  });

  it('clears the previous pick rather than appending to it', () => {
    const { doc, pickInfo } = fakeDocument();
    const ctx = loadDecls(['showPickInfo'], {
      entityMap: new Map<number, unknown>([
        [1, { ifcType: 'IfcWall', indexCount: 3 }],
        [2, { ifcType: 'IfcSlab', indexCount: 6 }],
      ]),
      document: doc,
    });
    ctx.showPickInfo(1);
    ctx.showPickInfo(2);
    assert.equal(pickInfo.children.length, 4, 'a second pick must replace the first four rows');
    assert.equal(pickInfo.children[1].textContent, 'IfcSlab');
  });

  it('leaves the panel untouched for an unknown entity', () => {
    const { doc, pickInfo } = fakeDocument();
    loadDecls(['showPickInfo'], { entityMap: new Map(), document: doc }).showPickInfo(99);
    assert.equal(pickInfo.children.length, 0);
    assert.equal(pickInfo.style.display, undefined, 'an unknown id must not open the panel');
  });
});
