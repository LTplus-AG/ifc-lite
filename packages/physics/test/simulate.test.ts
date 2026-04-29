/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it } from 'vitest';
import { init, simulate, type PhysicsMesh } from '../src/index.js';

function cube(
  expressId: number,
  ifcType: string,
  center: [number, number, number],
  size: [number, number, number],
): PhysicsMesh {
  const [hx, hy, hz] = [size[0] * 0.5, size[1] * 0.5, size[2] * 0.5];
  const [cx, cy, cz] = center;
  const positions = new Float32Array([
    cx - hx, cy - hy, cz - hz,
    cx + hx, cy - hy, cz - hz,
    cx + hx, cy + hy, cz - hz,
    cx - hx, cy + hy, cz - hz,
    cx - hx, cy - hy, cz + hz,
    cx + hx, cy - hy, cz + hz,
    cx + hx, cy + hy, cz + hz,
    cx - hx, cy + hy, cz + hz,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
  ]);
  return { expressId, ifcType, positions, indices };
}

describe('@ifc-lite/physics', () => {
  beforeAll(async () => {
    await init();
  });

  it('anchors a slab via IFC type heuristic and keeps a column resting on it stable', () => {
    const slab = cube(1, 'IfcSlab', [0, 0, 0.05], [4, 4, 0.1]);
    const column = cube(2, 'IfcColumn', [0, 0, 1.6], [0.3, 0.3, 3.0]);
    const result = simulate([slab, column], { durationSeconds: 1.0 });
    expect(result.anchored).toContain(1);
    expect(result.stable).toContain(2);
    expect(result.falling).not.toContain(2);
  });

  it('classifies the slab as falling when its only support is removed', () => {
    const column = cube(1, 'IfcColumn', [0, 0, 1.5], [0.3, 0.3, 3.0]);
    const slab = cube(2, 'IfcSlab', [0, 0, 3.05], [3, 3, 0.1]);
    const footing = cube(3, 'IfcFooting', [0, 0, -0.05], [1, 1, 0.1]);

    const baseline = simulate([footing, column, slab], { durationSeconds: 1.0 });
    expect(baseline.anchored).toContain(3);
    expect(baseline.stable).toContain(2);

    const removed = simulate([footing, column, slab], {
      remove: [1],
      durationSeconds: 1.5,
    });
    expect(removed.removed).toEqual([1]);
    expect(removed.bodies.find(b => b.expressId === 1)).toBeUndefined();
    expect(removed.falling).toContain(2);
  });

  it('honors explicit anchor list', () => {
    const column = cube(1, 'IfcColumn', [0, 0, 1.5], [0.3, 0.3, 3.0]);
    const result = simulate([column], { anchor: [1], durationSeconds: 0.5 });
    expect(result.anchored).toContain(1);
    expect(result.stable).toContain(1);
  });

  it('explicit connection welds far-apart elements together', () => {
    const anchor = cube(1, 'IfcFooting', [0, 0, 0], [1, 1, 0.1]);
    const floater = cube(2, 'IfcBeam', [5, 0, 1], [0.3, 0.3, 0.3]);

    const baseline = simulate([anchor, floater], { durationSeconds: 1.0 });
    expect(baseline.falling).toContain(2);

    const linked = simulate([anchor, floater], {
      durationSeconds: 1.0,
      connections: [[1, 2]],
    });
    expect(linked.falling).not.toContain(2);
    expect(linked.joints.some(([a, b]) => (a === 1 && b === 2) || (a === 2 && b === 1))).toBe(true);
  });

  it('deduplicates explicit connections against AABB-touch pairs', () => {
    const slab = cube(1, 'IfcSlab', [0, 0, 0.05], [4, 4, 0.1]);
    const column = cube(2, 'IfcColumn', [0, 0, 1.6], [0.3, 0.3, 3.0]);
    const result = simulate([slab, column], {
      durationSeconds: 0.5,
      connections: [[1, 2], [2, 1]],
    });
    const matches = result.joints.filter(
      ([a, b]) => (a === 1 && b === 2) || (a === 2 && b === 1),
    );
    expect(matches).toHaveLength(1);
  });

  it('auto collider strategy keeps a column on an anchored slab stable', () => {
    const slab = cube(1, 'IfcSlab', [0, 0, 0.05], [4, 4, 0.1]);
    const column = cube(2, 'IfcColumn', [0, 0, 1.6], [0.3, 0.3, 3.0]);
    const result = simulate([slab, column], {
      durationSeconds: 1.0,
      colliderStrategy: 'auto',
    });
    expect(result.stable).toContain(2);
  });

  it('forced trimesh strategy still simulates without dropping bodies', () => {
    const slab = cube(1, 'IfcSlab', [0, 0, 0.05], [4, 4, 0.1]);
    const column = cube(2, 'IfcColumn', [0, 0, 1.6], [0.3, 0.3, 3.0]);
    const result = simulate([slab, column], {
      durationSeconds: 0.5,
      colliderStrategy: 'trimesh',
    });
    expect(result.bodies).toHaveLength(2);
  });

  it('skips empty meshes', () => {
    const empty: PhysicsMesh = {
      expressId: 99,
      ifcType: 'IfcWall',
      positions: new Float32Array(),
      indices: new Uint32Array(),
    };
    const result = simulate([empty]);
    expect(result.bodies).toHaveLength(0);
  });
});
