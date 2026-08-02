/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * footprint.ts (Bet B1.4): the crux ancestor-exclusion rule (structural
 * conflicts), the spatial epsilon rule, and the soundness invariant
 * (writtenNodes intersection must ALWAYS report a conflict, regardless of
 * region state — see footprint.ts's module docstring for the full rationale).
 */

import { describe, expect, it } from 'vitest';
import { ProvenanceDag, type NodeSpec } from './dag-engine.js';
import type { ElementPayload, GeometryMeshPayload, LayerPayload, PropertySetPayload, RelationshipPayload } from './node-hash.js';
import {
  aabbFromMesh,
  computeFootprint,
  conflictPredicate,
  DEFAULT_EPSILON_MM,
  inflateAabb,
  unionAabb,
  type Aabb,
  type EditOp,
} from './footprint.js';

/* ------------------------------------------------------------------ */
/* Fixed DAG, same shape as dag-engine.test.ts's addFixedDag:            */
/*                                                                       */
/*   root (layer)                                                       */
/*   ├─ storeyRel (relationship) -> element1, element2                  */
/*   │    element1 (element) -> meshA (geometry-mesh), psetX (pset)     */
/*   │    element2 (element) -> meshB (geometry-mesh), psetY (pset)     */
/*   └─ element3 (element) -> meshC (geometry-mesh)  [direct root child] */
/* ------------------------------------------------------------------ */

function mesh(expressId: number, origin: readonly [number, number, number] = [0, 0, 0]): GeometryMeshPayload {
  return {
    expressId,
    geometryClass: 0,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    origin,
  };
}

function buildFixedDag(): ProvenanceDag {
  const dag = new ProvenanceDag();
  const specs: NodeSpec[] = [
    { id: 'meshA', kind: 'geometry-mesh', payload: mesh(100) },
    { id: 'meshB', kind: 'geometry-mesh', payload: mesh(200) },
    { id: 'meshC', kind: 'geometry-mesh', payload: mesh(300) },
    {
      id: 'psetX',
      kind: 'property-set',
      payload: { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] } satisfies PropertySetPayload,
    },
    {
      id: 'psetY',
      kind: 'property-set',
      payload: { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: false }] } satisfies PropertySetPayload,
    },
    {
      id: 'element1',
      kind: 'element',
      children: ['meshA', 'psetX'],
      buildPayload: (h): ElementPayload => ({
        key: 'element-1',
        ifcType: 'IfcWall',
        components: [
          { componentKey: 'geometry-mesh', hash: h.get('meshA')! },
          { componentKey: 'pset:Pset_WallCommon', hash: h.get('psetX')! },
        ],
      }),
    },
    {
      id: 'element2',
      kind: 'element',
      children: ['meshB', 'psetY'],
      buildPayload: (h): ElementPayload => ({
        key: 'element-2',
        ifcType: 'IfcWall',
        components: [
          { componentKey: 'geometry-mesh', hash: h.get('meshB')! },
          { componentKey: 'pset:Pset_WallCommon', hash: h.get('psetY')! },
        ],
      }),
    },
    {
      id: 'element3',
      kind: 'element',
      children: ['meshC'],
      buildPayload: (h): ElementPayload => ({
        key: 'element-3',
        ifcType: 'IfcColumn',
        components: [{ componentKey: 'geometry-mesh', hash: h.get('meshC')! }],
      }),
    },
    {
      id: 'storeyRel',
      kind: 'relationship',
      children: ['element1', 'element2'],
      buildPayload: (h): RelationshipPayload => ({
        relType: 'IfcRelContainedInSpatialStructure',
        roles: [{ roleName: 'RelatedElements', refs: [h.get('element1')!, h.get('element2')!] }],
      }),
    },
    {
      id: 'root',
      kind: 'layer',
      children: ['storeyRel', 'element3'],
      buildPayload: (h): LayerPayload => ({
        layerId: 'blake3:test-root',
        childHashes: [h.get('storeyRel')!, h.get('element3')!],
      }),
    },
  ];
  for (const spec of specs) dag.addNode(spec);
  return dag;
}

function propertyEdit(opId: string, targetNodeIds: readonly string[], region?: Aabb): EditOp {
  return { opId, kind: 'property-edit', targetNodeIds, region };
}

function geometryEdit(opId: string, targetNodeIds: readonly string[], region: Aabb): EditOp {
  return { opId, kind: 'geometry-edit', targetNodeIds, region };
}

/* ------------------------------------------------------------------ */
/* Structural: the crux ancestor-exclusion rule                        */
/* ------------------------------------------------------------------ */

describe('computeFootprint: ancestor-exclusion rule (the crux)', () => {
  it('a leaf edit under element1 has writtenNodes = {leaf, element1} — NOT storeyRel, NOT root', async () => {
    const dag = buildFixedDag();
    await dag.build();
    const fp = computeFootprint(dag, propertyEdit('opA', ['psetX']));
    expect(fp.writtenNodes).toEqual(new Set(['psetX', 'element1']));
  });

  it('a leaf edit under element3 (direct root child) has writtenNodes = {leaf, element3} — NOT root', async () => {
    const dag = buildFixedDag();
    await dag.build();
    const fp = computeFootprint(dag, propertyEdit('opA', ['meshC']));
    expect(fp.writtenNodes).toEqual(new Set(['meshC', 'element3']));
  });

  it('an op targeting an element node directly includes just that element (its own ancestor, storeyRel, is excluded)', async () => {
    const dag = buildFixedDag();
    await dag.build();
    const fp = computeFootprint(dag, propertyEdit('opA', ['element1']));
    expect(fp.writtenNodes).toEqual(new Set(['element1']));
  });
});

describe('conflictPredicate: structural conflicts', () => {
  it('two edits to two different leaves of the SAME element conflict (pset vs mesh, element1)', async () => {
    const dag = buildFixedDag();
    await dag.build();
    const fpA = computeFootprint(dag, propertyEdit('opA', ['psetX']));
    const fpB = computeFootprint(dag, geometryEdit('opB', ['meshA'], { min: [0, 0, 0], max: [1, 1, 1] }));
    const result = conflictPredicate(fpA, fpB);
    expect(result.structural).toBe(true);
    expect(result.conflict).toBe(true);
  });

  it('two edits to the SAME pset node (identical target) conflict', async () => {
    const dag = buildFixedDag();
    await dag.build();
    const fpA = computeFootprint(dag, propertyEdit('opA', ['psetX']));
    const fpB = computeFootprint(dag, propertyEdit('opB', ['psetX']));
    expect(conflictPredicate(fpA, fpB).structural).toBe(true);
  });

  it('two edits under DIFFERENT elements of the SAME storey do NOT conflict merely by sharing the storey ancestor', async () => {
    const dag = buildFixedDag();
    await dag.build();
    // element1's pset vs element2's pset: both roll up into storeyRel and
    // root, but writtenNodes excludes those aggregator ancestors, so the
    // shared-storey noise never surfaces as a structural conflict.
    const fpA = computeFootprint(dag, propertyEdit('opA', ['psetX']));
    const fpB = computeFootprint(dag, propertyEdit('opB', ['psetY']));
    const result = conflictPredicate(fpA, fpB);
    expect(result.structural).toBe(false);
    expect(result.conflict).toBe(false);
  });

  it('an element1-branch edit and the element3 (direct root child) edit do NOT conflict (disjoint branches, only root shared)', async () => {
    const dag = buildFixedDag();
    await dag.build();
    const fpA = computeFootprint(dag, propertyEdit('opA', ['psetX']));
    const fpB = computeFootprint(dag, geometryEdit('opB', ['meshC'], { min: [100, 100, 100], max: [101, 101, 101] }));
    expect(conflictPredicate(fpA, fpB).structural).toBe(false);
  });

  it('computeFootprint throws on an unknown target node id', async () => {
    const dag = buildFixedDag();
    await dag.build();
    expect(() => computeFootprint(dag, propertyEdit('opA', ['doesNotExist']))).toThrow(/unknown target node id/);
  });
});

/* ------------------------------------------------------------------ */
/* Spatial: epsilon-inflated AABB intersection                          */
/* ------------------------------------------------------------------ */

describe('conflictPredicate: spatial conflicts', () => {
  it('disjoint boxes, far apart, do not conflict', async () => {
    const dag = buildFixedDag();
    await dag.build();
    // element1 vs element3: disjoint structurally too, isolates the spatial check.
    const fpA = computeFootprint(dag, geometryEdit('opA', ['meshA'], { min: [0, 0, 0], max: [1, 1, 1] }));
    const fpB = computeFootprint(dag, geometryEdit('opB', ['meshC'], { min: [100, 100, 100], max: [101, 101, 101] }));
    const result = conflictPredicate(fpA, fpB);
    expect(result.spatial).toBe(false);
    expect(result.conflict).toBe(false);
  });

  it('overlapping boxes conflict spatially regardless of epsilon', async () => {
    const dag = buildFixedDag();
    await dag.build();
    const fpA = computeFootprint(dag, geometryEdit('opA', ['meshA'], { min: [0, 0, 0], max: [2, 2, 2] }));
    const fpB = computeFootprint(dag, geometryEdit('opB', ['meshC'], { min: [1, 1, 1], max: [3, 3, 3] }));
    const result = conflictPredicate(fpA, fpB, { epsilonMm: 0 });
    expect(result.spatial).toBe(true);
    expect(result.conflict).toBe(true);
  });

  it('adjacent boxes within epsilon conflict; the same gap beyond epsilon does not', async () => {
    const dag = buildFixedDag();
    await dag.build();
    // Two 1m boxes with a 40mm gap between them: [0,1] and [1.04,2.04] on X.
    const gapMeters = 0.04;
    const fpA = computeFootprint(dag, geometryEdit('opA', ['meshA'], { min: [0, 0, 0], max: [1, 1, 1] }));
    const fpB = computeFootprint(
      dag,
      geometryEdit('opB', ['meshC'], { min: [1 + gapMeters, 0, 0], max: [2 + gapMeters, 1, 1] }),
    );
    // Default epsilon (50mm) on each side inflates by 0.05m each: total closing
    // distance 0.1m > 0.04m gap, so they touch after inflation.
    const withDefaultEpsilon = conflictPredicate(fpA, fpB);
    expect(withDefaultEpsilon.spatial).toBe(true);
    expect(withDefaultEpsilon.conflict).toBe(true);

    // With epsilon = 0, no inflation, and the boxes have a real 40mm gap: no conflict.
    const withZeroEpsilon = conflictPredicate(fpA, fpB, { epsilonMm: 0 });
    expect(withZeroEpsilon.spatial).toBe(false);
    expect(withZeroEpsilon.conflict).toBe(false);
  });

  it('DEFAULT_EPSILON_MM is 50 (the M1 clearance-to-structure tolerance)', () => {
    expect(DEFAULT_EPSILON_MM).toBe(50);
  });

  it('property-only edits (no region) never spatially conflict, only structurally', async () => {
    const dag = buildFixedDag();
    await dag.build();
    const fpA = computeFootprint(dag, propertyEdit('opA', ['psetX']));
    const fpB = computeFootprint(dag, propertyEdit('opB', ['psetY']));
    expect(fpA.region).toBeNull();
    expect(fpB.region).toBeNull();
    expect(conflictPredicate(fpA, fpB).spatial).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Soundness invariant: structural intersection ALWAYS conflicts,        */
/* regardless of region state (no region, disjoint region, or same).    */
/* ------------------------------------------------------------------ */

describe('conflictPredicate: soundness invariant', () => {
  const regionVariants: (Aabb | undefined)[] = [
    undefined,
    { min: [0, 0, 0], max: [1, 1, 1] },
    { min: [500, 500, 500], max: [501, 501, 501] }, // far away, would never spatially conflict
  ];

  for (const regionA of regionVariants) {
    for (const regionB of regionVariants) {
      it(`same-element structural conflict holds regardless of region combo (A=${JSON.stringify(regionA)}, B=${JSON.stringify(regionB)})`, async () => {
        const dag = buildFixedDag();
        await dag.build();
        const opA: EditOp = { opId: 'opA', kind: 'property-edit', targetNodeIds: ['psetX'], region: regionA };
        const opB: EditOp = { opId: 'opB', kind: 'geometry-edit', targetNodeIds: ['meshA'], region: regionB };
        const fpA = computeFootprint(dag, opA);
        const fpB = computeFootprint(dag, opB);
        // Never missed: writtenNodes genuinely intersect (both touch element1).
        expect(conflictPredicate(fpA, fpB, { epsilonMm: 0 }).conflict).toBe(true);
      });
    }
  }
});

/* ------------------------------------------------------------------ */
/* AABB helpers                                                          */
/* ------------------------------------------------------------------ */

describe('aabbFromMesh / unionAabb', () => {
  it('folds mesh origin into local-frame positions', () => {
    const m: GeometryMeshPayload = {
      expressId: 1,
      geometryClass: 0,
      positions: [-1, -2, -3, 4, 5, 6],
      normals: [0, 0, 1, 0, 0, 1],
      indices: [0, 1],
      origin: [10, 20, 30],
    };
    const box = aabbFromMesh(m);
    expect(box.min).toEqual([9, 18, 27]);
    expect(box.max).toEqual([14, 25, 36]);
  });

  it('throws on an empty positions array', () => {
    const m: GeometryMeshPayload = {
      expressId: 1,
      geometryClass: 0,
      positions: [],
      normals: [],
      indices: [],
      origin: [0, 0, 0],
    };
    expect(() => aabbFromMesh(m)).toThrow(/at least one vertex/);
  });

  it('unionAabb combines several boxes into their bounding box', () => {
    const a: Aabb = { min: [0, 0, 0], max: [1, 1, 1] };
    const b: Aabb = { min: [-1, 2, 0.5], max: [0.5, 3, 4] };
    const union = unionAabb([a, b]);
    expect(union.min).toEqual([-1, 0, 0]);
    expect(union.max).toEqual([1, 3, 4]);
  });

  it('inflateAabb expands by epsilonMm/1000 per axis, per side', () => {
    const box: Aabb = { min: [0, 0, 0], max: [1, 1, 1] };
    const inflated = inflateAabb(box, 50);
    expect(inflated.min).toEqual([-0.05, -0.05, -0.05]);
    expect(inflated.max).toEqual([1.05, 1.05, 1.05]);
  });
});
