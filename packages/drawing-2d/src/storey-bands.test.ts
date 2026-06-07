/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { currentFloorBands, storeyFloorsFromMeshes, type StoreyFloorMesh } from './storey-bands.js';
import { classifyDepthRange, signedAxisDepth } from './projection-bands.js';

// A mesh that occupies world-Y [minY, maxY]; only the Y values matter here.
function meshY(expressId: number, minY: number, maxY: number): StoreyFloorMesh {
  return {
    expressId,
    positions: new Float32Array([0, minY, 0, 1, maxY, 0, 1, minY, 1]),
  };
}

describe('storeyFloorsFromMeshes', () => {
  it('returns each storey floor as the min member-Y, sorted ascending', () => {
    const meshes = [
      meshY(1, 0.0, 2.6), // ground wall
      meshY(2, 0.0, 0.2), // ground slab
      meshY(3, 2.7, 5.0), // attic wall + roof
    ];
    const elementToStorey = new Map([
      [1, 100], [2, 100], // storey 100 (ground)
      [3, 200],           // storey 200 (attic)
    ]);
    // Float32Array round-trips the literals, so compare with a tolerance.
    const floors = storeyFloorsFromMeshes(meshes, elementToStorey);
    expect(floors).toHaveLength(2);
    expect(floors[0]).toBeCloseTo(0.0, 5);
    expect(floors[1]).toBeCloseTo(2.7, 5);
  });

  it('reflects the slab-underside reality: a slab extruded below the datum lowers the level', () => {
    // Attic floor slab modelled from 2.5..2.7 (underside 0.2 below the 2.7 datum).
    const meshes = [meshY(1, 0.0, 2.6), meshY(2, 2.5, 2.7)];
    const elementToStorey = new Map([[1, 100], [2, 200]]);
    // The attic level reads as 2.5 (the slab underside), not the 2.7 datum.
    const floors = storeyFloorsFromMeshes(meshes, elementToStorey);
    expect(floors).toHaveLength(2);
    expect(floors[0]).toBeCloseTo(0.0, 5);
    expect(floors[1]).toBeCloseTo(2.5, 5);
  });

  it('skips storeyless meshes (site, roof-on-building) and empty storeys', () => {
    const meshes = [
      meshY(1, 0.0, 2.6), // ground
      meshY(9, -1.0, 0.0), // site terrain — NOT in elementToStorey
    ];
    const elementToStorey = new Map([[1, 100]]);
    expect(storeyFloorsFromMeshes(meshes, elementToStorey)).toEqual([0.0]);
  });

  it('documents the storey-spanning limitation: an upper-storey element reaching down collapses levels', () => {
    // A stair assigned to the ATTIC (200) but spanning down to the ground floor
    // pulls storey 200's min-Y to 0, colliding with the ground floor.
    const meshes = [
      meshY(1, 0.0, 2.6), // ground wall → storey 100
      meshY(3, 2.7, 5.0), // attic wall → storey 200
      meshY(4, 0.0, 2.7), // attic stair spanning down → storey 200
    ];
    const elementToStorey = new Map([[1, 100], [3, 200], [4, 200]]);
    // Known limitation: storey 200's level collapses to 0, so the two storeys
    // are no longer distinguished by floor level. Scoping then degrades toward
    // full-extent for such cuts (never worse than the pre-fix baseline).
    expect(storeyFloorsFromMeshes(meshes, elementToStorey)).toEqual([0.0, 0.0]);
  });
});

describe('currentFloorBands', () => {
  // AC20-FZK-Haus-like two-storey model: ground @0, attic @2.7, a little site
  // below the ground (axisMin = -0.3) and a pitched roof up to axisMax = 5.
  const FLOORS = [0, 2.7];
  const AXIS_MIN = -0.3;
  const AXIS_MAX = 5;

  it('ground-floor cut: floor extends down to the model bottom, ceil to the attic floor', () => {
    const { below, above } = currentFloorBands(FLOORS, 1.0, AXIS_MIN, AXIS_MAX);
    // below = position - min(axisMin, floor0) = 1.0 - (-0.3) = 1.3 (site shows)
    expect(below).toBeCloseTo(1.3, 6);
    // above = nextFloor - position = 2.7 - 1.0 = 1.7 (capped at the attic floor)
    expect(above).toBeCloseTo(1.7, 6);
  });

  it('ground-floor cut culls the roof two levels up', () => {
    const { below, above } = currentFloorBands(FLOORS, 1.0, AXIS_MIN, AXIS_MAX);
    // The roof BODY sits well above the attic floor (3.5..5); relative to the
    // ground cut its depth (2.5..4.0) clears the overhead band (above = 1.7).
    const dMin = signedAxisDepth(3.5, 1.0, false); // 2.5
    const dMax = signedAxisDepth(AXIS_MAX, 1.0, false); // 4.0
    expect(classifyDepthRange(dMin, dMax, { below, above })).toBe('cull');
  });

  it('attic cut: top storey ceil extends up to the model top so the roof projects', () => {
    const { below, above } = currentFloorBands(FLOORS, 2.8, AXIS_MIN, AXIS_MAX);
    expect(below).toBeCloseTo(0.1, 6); // 2.8 - 2.7
    expect(above).toBeCloseTo(2.2, 6); // max(axisMax, 2.7) - 2.8 = 5 - 2.8
    // The roof (above 2.8) now classifies as overhead (dashed), not culled.
    const dMin = signedAxisDepth(2.9, 2.8, false);
    const dMax = signedAxisDepth(AXIS_MAX, 2.8, false);
    expect(classifyDepthRange(dMin, dMax, { below, above })).toBe('overhead');
  });

  it('attic cut culls the ground floor below', () => {
    const { below, above } = currentFloorBands(FLOORS, 2.8, AXIS_MIN, AXIS_MAX);
    // A ground-floor wall spanning 0..2.6 is entirely below the attic floor.
    const dMin = signedAxisDepth(0, 2.8, false); // -2.8
    const dMax = signedAxisDepth(2.6, 2.8, false); // -0.2
    expect(classifyDepthRange(dMin, dMax, { below, above })).toBe('cull');
  });

  it('scopes a middle storey to its neighbours (no axis-extent bleed)', () => {
    const floors = [0, 3, 6];
    const { below, above } = currentFloorBands(floors, 4.0, -1, 9);
    expect(below).toBeCloseTo(1.0, 6); // 4 - 3 (this storey's own floor)
    expect(above).toBeCloseTo(2.0, 6); // 6 - 4 (next storey's floor, not axisMax)
  });

  it('a cut below the lowest floor still belongs to the bottom storey', () => {
    const { below, above } = currentFloorBands([0, 3], -0.5, -2, 9);
    // k = 0; floor = min(axisMin, 0) = -2; ceil = 3.
    expect(below).toBeCloseTo(1.5, 6); // -0.5 - (-2)
    expect(above).toBeCloseTo(3.5, 6); // 3 - (-0.5)
  });

  it('floors every band at minDepth so a cut on a boundary never yields 0 width', () => {
    // Cut exactly on the attic floor (2.7): k = 1 (top), floor = 2.7.
    const { below } = currentFloorBands([0, 2.7], 2.7, 0, 2.7);
    expect(below).toBe(1e-3); // position - floor = 0 → clamped
  });

  it('single storey degenerates to full extent around the one floor', () => {
    const { below, above } = currentFloorBands([0], 1.0, -1, 5);
    expect(below).toBeCloseTo(2.0, 6); // 1 - min(-1, 0) = 1 - (-1)
    expect(above).toBeCloseTo(4.0, 6); // max(5, 0) - 1
  });
});
