/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Clash.distance` for a hard clash is either a depth MEASURED on the triangle
 * meshes or an ESTIMATE read off the element AABBs, and until `distanceKind`
 * existed the two were indistinguishable in the output. These fixtures pin one
 * pair per code path, and pin the distances themselves so the labelling can
 * never be mistaken for a change of the numbers.
 */

import { describe, expect, it } from 'vitest';
import { testPair } from './narrow.js';
import { TriMesh } from './tri-mesh.js';
import { createClashEngine } from '../engine.js';
import type { ClashElement, ClashRule, Vec3 } from '../types.js';

let nextRef = 1;

/** Axis-aligned box element spanning `min`..`max` (12 triangles, closed). */
function boxEl(key: string, tag: string, min: Vec3, max: Vec3): ClashElement {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { key, ref: nextRef++, model: 'm', tag, positions, indices, bounds: { min, max } };
}

const RULE: ClashRule = { id: 'r', name: 'r', a: '*', b: '*', mode: 'hard' };

function pair(a: ClashElement, b: ClashElement) {
  const res = testPair(a, new TriMesh(a.positions!, a.indices!), b, new TriMesh(b.positions!, b.indices!), RULE, 0.001);
  if (!res) throw new Error('expected a clash');
  return res;
}

describe('hard-clash distance provenance', () => {
  it('labels a genuine crossing as mesh-measured', () => {
    // A block driven 75 mm into a 200 mm slab: the block's lower corners are
    // strictly inside the slab, so the mesh probe has a vertex to measure from.
    const res = pair(
      boxEl('A', 'IfcSlab', [0, 0, 0], [10, 10, 0.2]),
      boxEl('B', 'IfcFooting', [4, 4, 0.125], [5, 5, 1]),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('mesh');
    expect(res.distance).toBe(-0.07500000298023224);
  });

  it('labels a stack whose footprints do NOT coincide as mesh-measured', () => {
    // The upper slab is inset, so the lower slab's top corners fall strictly
    // inside it and the mesh probe fires.
    const res = pair(
      boxEl('A', 'IfcSlab', [0, 0, 0], [10, 10, 0.2]),
      boxEl('B', 'IfcSlab', [1, 1, 0.16], [9, 9, 0.41]),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('mesh');
    expect(res.distance).toBe(-0.040000006556510925);
  });

  it('labels a member piercing clean through as an AABB estimate', () => {
    // A thin bar passing right through a slab. The triangles genuinely cross,
    // but every crossing-triangle vertex is OUTSIDE the other solid — the bar's
    // ends stick out, the slab's caps reach far beyond the bar — so
    // `maxPenetrationInto` returns 0 on both sides and the reported number is
    // the smallest overlapping BOX dimension.
    const res = pair(
      boxEl('A', 'IfcSlab', [0, 0, 0], [10, 10, 0.2]),
      boxEl('B', 'IfcColumn', [4, 4, -5], [4.3, 4.3, 5]),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('estimate');
    expect(res.distance).toBe(-0.2);
  });

  it('labels coincident-footprint stacked layers as an AABB estimate', () => {
    // Two pavement layers with the same footprint, overlapping 40 mm. Their
    // surfaces only COINCIDE — no triangle pair crosses — so this lands in the
    // coplanar-overlap branch, whose distance is the AABB signed gap, i.e. the
    // smallest overlapping box dimension. Nothing was measured on the meshes.
    const res = pair(
      boxEl('A', 'IfcSlab', [0, 0, 0], [10, 10, 0.2]),
      boxEl('B', 'IfcSlab', [0, 0, 0.16], [10, 10, 0.41]),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('estimate');
    expect(res.distance).toBe(-0.04000000000000001);
  });

  it('labels an enclosed layer as an AABB estimate', () => {
    // A 40 mm layer modelled wholly inside a 250 mm one: no surface crossing at
    // all, so the enclosed-solid branch reports the AABB gap — which here is
    // exactly the thin layer's own thickness, the value most easily mistaken
    // for a measured depth.
    const res = pair(
      boxEl('A', 'IfcSlab', [0, 0, 0], [10, 10, 0.04]),
      boxEl('B', 'IfcSlab', [0, 0, 0], [10, 10, 0.25]),
    );
    expect(res.status).toBe('hard');
    expect(res.distanceKind).toBe('estimate');
    expect(res.distance).toBe(-0.04);
  });

  it('carries the label onto the public Clash', async () => {
    const engine = createClashEngine();
    const res = await engine.run(
      [
        boxEl('L1', 'IfcSlab', [0, 0, 0], [10, 10, 0.2]),
        boxEl('L2', 'IfcSlab', [0, 0, 0.16], [10, 10, 0.41]),
      ],
      [{ id: 'r', name: 'r', a: 'IfcSlab', b: 'IfcSlab', mode: 'hard' }],
    );
    expect(res.clashes).toHaveLength(1);
    expect(res.clashes[0].distanceKind).toBe('estimate');
  });
});

// The clearance rule needs a clearance value; declared here so the fixture above
// stays a plain hard rule.
const CLEARANCE_RULE: ClashRule = { id: 'c', name: 'c', a: '*', b: '*', mode: 'clearance', clearance: 1 };

describe('clearance distance provenance', () => {
  it('is mesh-measured', () => {
    const a = boxEl('A', 'IfcSlab', [0, 0, 0], [1, 1, 1]);
    const b = boxEl('B', 'IfcSlab', [0, 0, 1.5], [1, 1, 2.5]);
    const res = testPair(a, new TriMesh(a.positions!, a.indices!), b, new TriMesh(b.positions!, b.indices!), CLEARANCE_RULE, 0.001);
    expect(res?.status).toBe('clearance');
    expect(res?.distanceKind).toBe('mesh');
  });
});
