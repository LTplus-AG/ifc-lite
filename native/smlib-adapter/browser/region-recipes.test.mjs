// SPDX-License-Identifier: MPL-2.0
// Independent sampled evaluation of derived wire recipes, not SDK qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { regionWitnesses } from './region-recipes.mjs';
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
