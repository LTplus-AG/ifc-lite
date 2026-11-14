/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { planFootprintRoof, heightAt, signedArea, type PlanPoint } from './roof-footprint-plan.js';

const CORPUS: PlanPoint[][] = [
  [[0, 0], [10, 0], [10, 8], [5, 3], [0, 8]],
  [[0, 0], [10, 0], [10, 4], [6, 4], [4, 10], [0, 10]],
  [[0, 0], [10, 0], [10, 10], [7, 10], [6, 4], [3, 5], [2, 10], [0, 10]],
];

/** Ray crossing independent of the skeleton and its line clipping. */
function contains(polygon: readonly PlanPoint[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > y) !== (b[1] > y) && x < a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1])) inside = !inside;
  }
  return inside;
}

/** A complete partition has neither uncovered samples nor overlapping faces. */
function assertPartition(footprint: PlanPoint[], slope: number, overhang: number) {
  const plan = planFootprintRoof(footprint, footprint.map(() => slope), overhang);
  expect(plan.planes.reduce((sum, plane) => sum + signedArea(plane.outline), 0)).toBeCloseTo(signedArea(plan.eaves), 7);
  const points = plan.eaves;
  const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
  const minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
  for (let i = 0; i < 53; i++) for (let j = 0; j < 47; j++) {
    // Noncentral fractions avoid grid points deliberately on symmetric ridges.
    const x = minX + (maxX - minX) * (i + .371) / 53;
    const y = minY + (maxY - minY) * (j + .219) / 47;
    expect(plan.planes.filter(plane => contains(plane.outline, x, y)).length, `coverage at ${x},${y}`)
      .toBe(contains(plan.eaves, x, y) ? 1 : 0);
  }
  for (const a of plan.planes) for (const p of a.outline) {
    for (const b of plan.planes) for (const q of b.outline) {
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-7) {
        expect(heightAt(a, p)).toBeCloseTo(heightAt(b, q), 7);
      }
    }
  }
}

describe('arbitrary reflex footprint corpus (#9357)', () => {
  for (const [index, outline] of CORPUS.entries()) for (const slope of [Math.PI / 6, Math.PI / 4]) {
    for (const overhang of [0, .2]) it(`case ${index}, slope ${slope}, overhang ${overhang} tiles with continuous valleys`, () => {
      assertPartition(outline, slope, overhang);
      const angle = .413, cos = Math.cos(angle), sin = Math.sin(angle);
      assertPartition(outline.map(([x, y]) => [23 + x * cos - y * sin, -17 + x * sin + y * cos]), slope, overhang);
      assertPartition([...outline].reverse(), slope, overhang);
    });
  }

  it('an all-flat reflex footprint retains its outline (#9357)', () => {
    const plan = planFootprintRoof(CORPUS[0], CORPUS[0].map(() => 0), 0);
    expect(plan.planes).toHaveLength(0);
    expect(plan.shapeType).toBe('FLAT_ROOF');
    expect(signedArea(plan.eaves)).toBeCloseTo(55, 7);
  });

  it('keeps unequal slopes at an inside corner under an overhang refused (#9357)', () => {
    expect(() => planFootprintRoof([[0, 0], [10, 0], [10, 4], [6, 4], [6, 10], [0, 10]], [.5, .5, .3, .5, .5, .5], .2)).toThrow(/inside corner/);
  });
});
