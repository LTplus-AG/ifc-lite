/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `lod-geometry-utils.ts` had no test file. The LOD0/LOD1 generators exercise
 * its matrix maths well enough that flipping the cross-product handedness or
 * dropping the translation column both fail `lod0-generator.test.ts` — but the
 * degenerate paths do not: the empty-point AABB fallback and the
 * `toIfcArrayBuffer` view window were both mutable with the suite green.
 *
 * `toIfcArrayBuffer` is the FIRST thing both generators do to their input
 * (`lod0-generator.ts:80`, `lod1-generator.ts:138`). Returning the whole
 * backing buffer for a `Uint8Array` that is a WINDOW onto a larger one — the
 * ordinary result of slicing bytes out of a container or a pooled read — hands
 * the parser bytes that are not the model.
 */

import { describe, it, expect } from 'vitest';
import {
  toIfcArrayBuffer,
  normalizeIfcTypeName,
  aabbFromPoints,
  vec3,
  vec3Cross,
  vec3Normalize,
  mat4Identity,
  mat4Mul,
  mat4FromBasisTranslation,
  mat4TransformPoint,
} from './lod-geometry-utils.js';

describe('toIfcArrayBuffer', () => {
  it('honours the byteOffset/byteLength window of a partial view', () => {
    // The mutation-visible case: a view that is NOT the whole buffer. The
    // neighbouring bytes are deliberately non-zero so aliasing them shows up.
    const backing = new Uint8Array([0xff, 0xff, 1, 2, 3, 4, 0xff, 0xff]);
    const view = backing.subarray(2, 6);
    const out = toIfcArrayBuffer(view);
    expect(out.byteLength).toBe(4);
    expect(Array.from(new Uint8Array(out))).toEqual([1, 2, 3, 4]);
  });

  it('passes an ArrayBuffer straight through', () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    expect(toIfcArrayBuffer(buf)).toBe(buf);
  });

  it('avoids a copy for a full-coverage view', () => {
    const full = new Uint8Array([1, 2, 3, 4]);
    expect(toIfcArrayBuffer(full)).toBe(full.buffer);
  });

  it('handles a zero-length window without reaching past it', () => {
    const backing = new Uint8Array([9, 9, 9, 9]);
    expect(toIfcArrayBuffer(backing.subarray(2, 2)).byteLength).toBe(0);
  });
});

describe('aabbFromPoints', () => {
  it('brackets the points on every axis', () => {
    const box = aabbFromPoints([vec3(-1, 5, 2), vec3(3, -4, 8), vec3(0, 0, 0)]);
    expect(box.min).toEqual([-1, -4, 0]);
    expect(box.max).toEqual([3, 5, 8]);
  });

  it('returns a degenerate box at the origin for no points, not a unit box', () => {
    // The Infinity seeds must not leak into the export; the documented
    // fallback is a zero-size box AT THE ORIGIN.
    expect(aabbFromPoints([])).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
  });

  it('returns the point itself for a single point', () => {
    expect(aabbFromPoints([vec3(2, 3, 4)])).toEqual({ min: [2, 3, 4], max: [2, 3, 4] });
  });
});

describe('vec3Normalize', () => {
  it('scales to unit length', () => {
    expect(vec3Normalize(vec3(0, 0, 5), [1, 0, 0])).toEqual([0, 0, 1]);
  });

  it('returns the caller fallback for a degenerate or non-finite vector', () => {
    expect(vec3Normalize(vec3(0, 0, 0), [1, 0, 0])).toEqual([1, 0, 0]);
    expect(vec3Normalize(vec3(NaN, 0, 0), [0, 1, 0])).toEqual([0, 1, 0]);
  });
});

describe('vec3Cross', () => {
  it('is right-handed: X cross Y is +Z', () => {
    expect(vec3Cross(vec3(1, 0, 0), vec3(0, 1, 0))).toEqual([0, 0, 1]);
    expect(vec3Cross(vec3(0, 1, 0), vec3(1, 0, 0))).toEqual([0, 0, -1]);
  });
});

describe('mat4 helpers', () => {
  it('mat4Identity is the multiplicative identity on both sides', () => {
    const m = mat4FromBasisTranslation([0, 1, 0], [-1, 0, 0], [0, 0, 1], [5, 6, 7]);
    expect(Array.from(mat4Mul(mat4Identity(), m))).toEqual(Array.from(m));
    expect(Array.from(mat4Mul(m, mat4Identity()))).toEqual(Array.from(m));
  });

  it('mat4FromBasisTranslation puts the basis in the columns and the translation last', () => {
    const m = mat4FromBasisTranslation([1, 0, 0], [0, 1, 0], [0, 0, 1], [5, 6, 7]);
    expect(Array.from(m)).toEqual([
      1, 0, 0, 5,
      0, 1, 0, 6,
      0, 0, 1, 7,
      0, 0, 0, 1,
    ]);
  });

  it('mat4TransformPoint applies rotation AND translation', () => {
    // A 90-degree yaw with a non-zero translation: an identity rotation would
    // hide a dropped basis, and a zero translation would hide a dropped column.
    const m = mat4FromBasisTranslation([0, 1, 0], [-1, 0, 0], [0, 0, 1], [5, 6, 7]);
    expect(mat4TransformPoint(m, vec3(1, 0, 0))).toEqual([5, 7, 7]);
  });

  it('mat4Mul composes parent-then-child in that order', () => {
    // Translate by (10,0,0), then by (0,20,0), applied to the origin.
    const a = mat4FromBasisTranslation([1, 0, 0], [0, 1, 0], [0, 0, 1], [10, 0, 0]);
    const b = mat4FromBasisTranslation([1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 20, 0]);
    expect(mat4TransformPoint(mat4Mul(a, b), vec3(0, 0, 0))).toEqual([10, 20, 0]);
  });
});

describe('normalizeIfcTypeName', () => {
  it('keeps an already-PascalCase name', () => {
    expect(normalizeIfcTypeName('IfcWallStandardCase')).toBe('IfcWallStandardCase');
  });

  it('passes an uppercase STEP name through unchanged', () => {
    expect(normalizeIfcTypeName('IFCWALL')).toBe('IFCWALL');
  });

  it('trims, and maps empty/undefined input to the empty string', () => {
    expect(normalizeIfcTypeName('  IfcWall  ')).toBe('IfcWall');
    expect(normalizeIfcTypeName('')).toBe('');
    expect(normalizeIfcTypeName(undefined as unknown as string)).toBe('');
  });
});
