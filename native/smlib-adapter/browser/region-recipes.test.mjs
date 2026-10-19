// SPDX-License-Identifier: MPL-2.0
// Independent sampled evaluation of derived wire recipes, not SDK qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { regionWitnesses, rationalDiskWitnesses } from './region-recipes.mjs';
for (const fixture of regionWitnesses()) {
  test(`round3 recipe invariant: ${fixture.name}`, () => {
    const view = new DataView(fixture.recipe.buffer);
    let offset = 48, area = 0, perimeter = 0;
    for (let loop = 0; loop < fixture.loops; loop++) {
      const count = view.getUint32(offset + 4, true); offset += 8;
      const points = [];
      for (let segment = 0; segment < count; segment++) {
        const kind = view.getUint32(offset, true);
        const v = Array.from({ length: 12 }, (_, i) => view.getFloat64(offset + 8 + i * 8, true));
        offset += 104;
        const samples = kind === 1 ? 1 : 4096;
        const curve = [];
        for (let i = 0; i <= samples; i++) {
          if (kind === 1) curve.push([v[0] + (v[3] - v[0]) * i, v[1] + (v[4] - v[1]) * i]);
          else {
            const angle = v[10] + v[11] * i / samples;
            curve.push([v[0] + v[9] * (v[6] * Math.cos(angle) - v[5] * v[7] * Math.sin(angle)),
              v[1] + v[9] * (v[7] * Math.cos(angle) + v[5] * v[6] * Math.sin(angle))]);
          }
        }
        if (points.length) assert(Math.hypot(...curve[0].map((x, i) => x - points.at(-1)[i])) < 1e-10, 'connected composite trim');
        points.push(...curve);
      }
      assert(Math.hypot(...points[0].map((x, i) => x - points.at(-1)[i])) < 1e-10, 'closed profile');
      let loopArea = 0;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        loopArea += (a[0]*b[1] - b[0]*a[1]) / 2;
        perimeter += Math.hypot(a[0]-b[0], a[1]-b[1]);
      }
      if (fixture.loops > 1) assert(loop === 0 ? loopArea > 0 : loopArea < 0, 'explicit outer/hole winding');
      area += loopArea;
    }
    assert.equal(offset, fixture.recipe.length);
    assert(Math.abs(Math.abs(area) - fixture.area) < fixture.area * 1e-6, 'sampled area vs independent formula');
    assert(Math.abs(perimeter - fixture.perimeter) < fixture.perimeter * 1e-6, 'sampled perimeter vs independent formula');
  });
}

for (const fixture of rationalDiskWitnesses()) {
  test(`round3 rational coefficient invariant: ${fixture.name}`, () => {
    const view = new DataView(fixture.recipe.buffer);
    const degree = view.getUint32(40, true), count = view.getUint32(44, true);
    assert.equal(view.getUint32(0, true), 2);
    assert.equal(view.getUint32(32, true), 4);
    assert.equal(count, degree + 1);
    const controls = Array.from({ length: count }, (_, i) => Array.from({ length: 4 },
      (_, j) => view.getFloat64(72 + 32 * i + 8 * j, true)));
    const point = t => {
      const basis = degree === 1 ? [1 - t, t] : [(1 - t) ** 2, 2 * t * (1 - t), t ** 2];
      const denominator = controls.reduce((sum, p, i) => sum + basis[i] * p[3], 0);
      return [0, 1, 2].map(axis => controls.reduce((sum, p, i) => sum + basis[i] * p[3] * p[axis], 0) / denominator);
    };
    let length = 0, previous = point(0);
    for (let i = 1; i <= 4096; i++) {
      const p = point(i / 4096);
      length += Math.hypot(...p.map((v, axis) => v - previous[axis])); previous = p;
      if (degree === 2) {
        assert(Math.abs(Math.hypot(p[0], p[1]) - 4) < 1e-12);
        assert(p[0] >= 0 && p[1] >= 0 && p[2] === 0);
      } else assert(p[0] === 0 && p[1] === 0 && p[2] >= 0 && p[2] <= 5);
    }
    assert(Math.abs(length - (degree === 2 ? 2 * Math.PI : 5)) < 1e-7);
    assert(Math.abs(Math.PI * 0.25 ** 2 * length - fixture.expected) < 1e-7);
    const knotOffset = 72 + 32 * count;
    assert.equal(fixture.recipe.length, knotOffset + 32);
    assert.equal(view.getFloat64(knotOffset, true), 0);
    assert.equal(view.getFloat64(knotOffset + 16, true), 1);
    assert.equal(view.getUint32(knotOffset + 8, true), degree + 1);
    assert.equal(view.getUint32(knotOffset + 24, true), degree + 1);
    assert.deepEqual(point(0), degree === 2 ? [4, 0, 0] : [0, 0, 0]);
    assert.deepEqual(point(1), degree === 2 ? [0, 4, 0] : [0, 0, 5]);
  });
}
