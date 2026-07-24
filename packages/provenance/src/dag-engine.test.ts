/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ProvenanceDag (Bet B1.1, M1 midterm): correctness (incremental recompute
 * must be byte-identical to a from-scratch rebuild) and telemetry accuracy
 * (recomputed/cacheHits/hitRate must match the actual dirty-ancestor set).
 *
 * Two styles, per the task brief: a hand-built fixed DAG (easy to reason
 * about expected ancestor paths exactly) plus a property-test style harness
 * over randomized DAG shapes and randomized edit sequences (many seeds).
 */

import { describe, expect, it } from 'vitest';
import { ProvenanceDag, type NodeSpec } from './dag-engine.js';
import {
  computeNodeHash,
  type ElementPayload,
  type GeometryMeshPayload,
  type LayerPayload,
  type PropertySetPayload,
  type RelationshipPayload,
} from './node-hash.js';

/* ------------------------------------------------------------------ */
/* Fixed 10-node DAG (same shape as dag.test.ts) built via ProvenanceDag */
/* ------------------------------------------------------------------ */

function mesh(expressId: number): GeometryMeshPayload {
  return {
    expressId,
    geometryClass: 0,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    origin: [expressId, 0, 0],
  };
}

/**
 * Builds:
 *   root (layer)
 *   ├─ storeyRel (relationship) -> element1, element2
 *   │    element1 (element) -> meshA (geometry-mesh), psetX (property-set)
 *   │    element2 (element) -> meshB (geometry-mesh), psetY (property-set)
 *   └─ element3 (element) -> meshC (geometry-mesh)     [direct child of root, unrelated branch]
 */
function addFixedDag(dag: ProvenanceDag): void {
  const specs: NodeSpec[] = [
    { id: 'meshA', kind: 'geometry-mesh', payload: mesh(100) },
    { id: 'meshB', kind: 'geometry-mesh', payload: mesh(200) },
    { id: 'meshC', kind: 'geometry-mesh', payload: mesh(300) },
    {
      id: 'psetX',
      kind: 'property-set',
      payload: { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] } as PropertySetPayload,
    },
    {
      id: 'psetY',
      kind: 'property-set',
      payload: { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: false }] } as PropertySetPayload,
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
}

describe('ProvenanceDag: build from scratch', () => {
  it('hashes all 10 nodes and matches computeNodeHash called directly', async () => {
    const dag = new ProvenanceDag();
    addFixedDag(dag);
    await dag.build();

    expect(dag.size).toBe(10);
    const snap = dag.snapshot();
    expect(snap.size).toBe(10);

    // Cross-check meshA directly against computeNodeHash.
    const directMeshA = await computeNodeHash('geometry-mesh', mesh(100));
    expect(dag.getHash('meshA')).toBe(directMeshA);
  });

  it('throws on a reference to an unknown child id', async () => {
    const dag = new ProvenanceDag();
    dag.addNode({
      id: 'orphanParent',
      kind: 'layer',
      children: ['doesNotExist'],
      buildPayload: (h): LayerPayload => ({ layerId: 'blake3:x', childHashes: [h.get('doesNotExist')!] }),
    });
    await expect(dag.build()).rejects.toThrow(/unknown child/);
  });

  it('throws on a cycle', async () => {
    const dag = new ProvenanceDag();
    dag.addNode({
      id: 'a',
      kind: 'layer',
      children: ['b'],
      buildPayload: (h): LayerPayload => ({ layerId: 'blake3:a', childHashes: [h.get('b')!] }),
    });
    dag.addNode({
      id: 'b',
      kind: 'layer',
      children: ['a'],
      buildPayload: (h): LayerPayload => ({ layerId: 'blake3:b', childHashes: [h.get('a')!] }),
    });
    await expect(dag.build()).rejects.toThrow(/cycle/);
  });
});

describe('ProvenanceDag: invalidate + recompute telemetry accuracy', () => {
  it('a single leaf edit recomputes exactly {leaf, element, storeyRel, root} and reports correct telemetry', async () => {
    const dag = new ProvenanceDag();
    addFixedDag(dag);
    await dag.build();
    const before = dag.snapshot();

    dag.setPayload('psetX', {
      name: 'Pset_WallCommon',
      properties: [{ name: 'IsExternal', value: false }],
    } satisfies PropertySetPayload);
    const telemetry = await dag.recompute();

    expect(new Set(telemetry.recomputedNodeIds)).toEqual(new Set(['psetX', 'element1', 'storeyRel', 'root']));
    expect(telemetry.recomputed).toBe(4);
    expect(telemetry.totalNodes).toBe(10);
    expect(telemetry.cacheHits).toBe(6);
    expect(telemetry.hitRate).toBeCloseTo(0.6, 10);

    const after = dag.snapshot();
    expect(after.get('psetX')).not.toBe(before.get('psetX'));
    expect(after.get('element1')).not.toBe(before.get('element1'));
    expect(after.get('storeyRel')).not.toBe(before.get('storeyRel'));
    expect(after.get('root')).not.toBe(before.get('root'));
    // Untouched: meshes, psetY, element2, element3.
    for (const id of ['meshA', 'meshB', 'meshC', 'psetY', 'element2', 'element3']) {
      expect(after.get(id)).toBe(before.get(id));
    }
  });

  it('an edit on the unrelated element3 branch recomputes only {meshC, element3, root}', async () => {
    const dag = new ProvenanceDag();
    addFixedDag(dag);
    await dag.build();

    dag.setPayload('meshC', mesh(301));
    const telemetry = await dag.recompute();

    expect(new Set(telemetry.recomputedNodeIds)).toEqual(new Set(['meshC', 'element3', 'root']));
    expect(telemetry.recomputed).toBe(3);
    expect(telemetry.cacheHits).toBe(7);
    expect(telemetry.hitRate).toBeCloseTo(0.7, 10);
  });

  it('dirty set accumulates across multiple invalidate calls before one recompute', async () => {
    const dag = new ProvenanceDag();
    addFixedDag(dag);
    await dag.build();

    dag.setPayload('psetX', { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: false }] });
    // psetX's ancestor chain: element1 -> storeyRel -> root, so invalidate marks 4 total.
    expect(dag.dirtyCount).toBe(4);
    dag.setPayload('meshC', mesh(302));
    // meshC's ancestors: element3 -> root (root already dirty, no-op)
    const telemetry = await dag.recompute();
    expect(new Set(telemetry.recomputedNodeIds)).toEqual(
      new Set(['psetX', 'element1', 'storeyRel', 'meshC', 'element3', 'root']),
    );
    expect(telemetry.recomputed).toBe(6);
    expect(telemetry.cacheHits).toBe(4);
  });

  it('recompute with nothing invalidated is a full-hit no-op', async () => {
    const dag = new ProvenanceDag();
    addFixedDag(dag);
    await dag.build();
    const before = dag.snapshot();

    const telemetry = await dag.recompute();
    expect(telemetry.recomputed).toBe(0);
    expect(telemetry.cacheHits).toBe(10);
    expect(telemetry.hitRate).toBe(1);
    expect(dag.snapshot()).toEqual(before);
  });

  it('recompute() before build() throws', async () => {
    const dag = new ProvenanceDag();
    addFixedDag(dag);
    await expect(dag.recompute()).rejects.toThrow(/build\(\)/);
  });
});

describe('ProvenanceDag: correctness — incremental result matches a from-scratch rebuild', () => {
  it('after a sequence of edits (pset + mesh), the incremental DAG matches a fresh build with the same final payloads', async () => {
    const dag = new ProvenanceDag();
    addFixedDag(dag);
    await dag.build();

    // Apply a sequence of edits incrementally.
    dag.setPayload('psetX', { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: false }] });
    await dag.recompute();
    dag.setPayload('meshB', mesh(9999));
    await dag.recompute();
    dag.setPayload('psetY', { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] });
    await dag.recompute();
    dag.setPayload('meshC', mesh(8888));
    await dag.recompute();

    // Build a FRESH dag with the same structure but the FINAL leaf payloads
    // applied from the start (a true from-scratch rebuild).
    const fresh = new ProvenanceDag();
    const specs: NodeSpec[] = [
      { id: 'meshA', kind: 'geometry-mesh', payload: mesh(100) },
      { id: 'meshB', kind: 'geometry-mesh', payload: mesh(9999) },
      { id: 'meshC', kind: 'geometry-mesh', payload: mesh(8888) },
      {
        id: 'psetX',
        kind: 'property-set',
        payload: { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: false }] },
      },
      {
        id: 'psetY',
        kind: 'property-set',
        payload: { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] },
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
    for (const spec of specs) fresh.addNode(spec);
    await fresh.build();

    expect(dag.snapshot()).toEqual(fresh.snapshot());
    expect(dag.getHash('root')).toBe(fresh.getHash('root'));
  });
});

/* ------------------------------------------------------------------ */
/* Property-test style: randomized DAG shapes + randomized edit sets    */
/* ------------------------------------------------------------------ */

/** Deterministic PRNG (mulberry32) — seeded so failures reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RandomDagShape {
  meshIds: string[];
  psetIds: string[];
  elementIds: string[];
  relIds: string[];
  /** Fixed structural spec builder: given CURRENT leaf payloads, produces the
   *  full NodeSpec[] for either an incremental DAG or a from-scratch rebuild. */
  buildSpecs: (leafPayloads: Map<string, unknown>) => NodeSpec[];
}

/**
 * Builds a random DAG shape: `meshCount` geometry-mesh leaves + `psetCount`
 * property-set leaves, grouped into `elementCount` element nodes (each
 * referencing 1-3 random leaves), grouped into a small number of
 * relationship nodes (each referencing 1-4 random elements), all under one
 * root layer node. Structure (which leaf belongs to which element, which
 * element belongs to which relationship) is fixed once per shape — only leaf
 * PAYLOADS vary across edits.
 */
function randomDagShape(rng: () => number, meshCount: number, psetCount: number, elementCount: number): RandomDagShape {
  const meshIds = Array.from({ length: meshCount }, (_, i) => `mesh:${i}`);
  const psetIds = Array.from({ length: psetCount }, (_, i) => `pset:${i}`);
  const leafIds = [...meshIds, ...psetIds];

  const elementChildren: string[][] = [];
  for (let e = 0; e < elementCount; e++) {
    const n = 1 + Math.floor(rng() * 3);
    const picked = new Set<string>();
    for (let k = 0; k < n; k++) {
      picked.add(leafIds[Math.floor(rng() * leafIds.length)]);
    }
    elementChildren.push([...picked]);
  }
  const elementIds = elementChildren.map((_, i) => `element:${i}`);

  const relCount = Math.max(1, Math.floor(elementCount / 3));
  const relChildren: string[][] = [];
  for (let r = 0; r < relCount; r++) {
    const n = 1 + Math.floor(rng() * 4);
    const picked = new Set<string>();
    for (let k = 0; k < n; k++) {
      picked.add(elementIds[Math.floor(rng() * elementIds.length)]);
    }
    relChildren.push([...picked]);
  }
  const relIds = relChildren.map((_, i) => `rel:${i}`);

  function buildSpecs(leafPayloads: Map<string, unknown>): NodeSpec[] {
    const specs: NodeSpec[] = [];
    for (const id of meshIds) {
      specs.push({ id, kind: 'geometry-mesh', payload: leafPayloads.get(id) as GeometryMeshPayload });
    }
    for (const id of psetIds) {
      specs.push({ id, kind: 'property-set', payload: leafPayloads.get(id) as PropertySetPayload });
    }
    elementIds.forEach((id, i) => {
      const children = elementChildren[i];
      specs.push({
        id,
        kind: 'element',
        children,
        buildPayload: (h): ElementPayload => ({
          key: id,
          ifcType: 'IfcRandomThing',
          components: children.map((c) => ({ componentKey: c, hash: h.get(c)! })),
        }),
      });
    });
    relIds.forEach((id, i) => {
      const children = relChildren[i];
      specs.push({
        id,
        kind: 'relationship',
        children,
        buildPayload: (h): RelationshipPayload => ({
          relType: 'IfcRandomRel',
          roles: [{ roleName: 'Members', refs: children.map((c) => h.get(c)!) }],
        }),
      });
    });
    specs.push({
      id: 'root',
      kind: 'layer',
      children: relIds,
      buildPayload: (h): LayerPayload => ({
        layerId: 'blake3:random-root',
        childHashes: relIds.map((r) => h.get(r)!),
      }),
    });
    return specs;
  }

  return { meshIds, psetIds, elementIds, relIds, buildSpecs };
}

function randomLeafPayload(rng: () => number, id: string, isMesh: boolean): unknown {
  if (isMesh) {
    const n = Math.floor(rng() * 1000);
    return {
      expressId: n,
      geometryClass: 0,
      positions: [rng(), rng(), rng(), rng(), rng(), rng(), rng(), rng(), rng()],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
      origin: [n, 0, 0],
    } satisfies GeometryMeshPayload;
  }
  return {
    name: `Pset_${id}`,
    properties: [{ name: 'Value', value: rng() }],
  } satisfies PropertySetPayload;
}

describe('ProvenanceDag: property-test — randomized DAGs and edit sets', () => {
  const SEEDS = [1, 2, 3, 7, 11, 42, 99, 1234, 5555, 20260724];

  for (const seed of SEEDS) {
    it(`seed=${seed}: incremental recompute over a random edit sequence matches a from-scratch rebuild`, async () => {
      const rng = mulberry32(seed);
      const meshCount = 3 + Math.floor(rng() * 4);
      const psetCount = 3 + Math.floor(rng() * 4);
      const elementCount = 4 + Math.floor(rng() * 6);
      const shape = randomDagShape(rng, meshCount, psetCount, elementCount);

      const leafPayloads = new Map<string, unknown>();
      for (const id of shape.meshIds) leafPayloads.set(id, randomLeafPayload(rng, id, true));
      for (const id of shape.psetIds) leafPayloads.set(id, randomLeafPayload(rng, id, false));

      const dag = new ProvenanceDag();
      for (const spec of shape.buildSpecs(leafPayloads)) dag.addNode(spec);
      await dag.build();

      const allLeafIds = [...shape.meshIds, ...shape.psetIds];
      const editCount = 5 + Math.floor(rng() * 10);
      const telemetries: import('./dag-engine.js').RecomputeTelemetry[] = [];

      for (let e = 0; e < editCount; e++) {
        const leafId = allLeafIds[Math.floor(rng() * allLeafIds.length)];
        const isMesh = shape.meshIds.includes(leafId);
        const newPayload = randomLeafPayload(rng, leafId, isMesh);
        leafPayloads.set(leafId, newPayload);
        dag.setPayload(leafId, newPayload as never);
        const telemetry = await dag.recompute();
        telemetries.push(telemetry);

        // Telemetry internal consistency, every single edit.
        expect(telemetry.cacheHits + telemetry.recomputed).toBe(telemetry.totalNodes);
        expect(telemetry.hitRate).toBeCloseTo(telemetry.cacheHits / telemetry.totalNodes, 10);
        expect(telemetry.recomputed).toBeGreaterThanOrEqual(1); // at least the leaf itself
      }

      // Cross-check: a FRESH dag built from scratch with the FINAL leaf
      // payloads must match the incrementally-recomputed dag, node for node.
      const fresh = new ProvenanceDag();
      for (const spec of shape.buildSpecs(leafPayloads)) fresh.addNode(spec);
      await fresh.build();

      expect(dag.snapshot()).toEqual(fresh.snapshot());
      expect(dag.getHash('root')).toBe(fresh.getHash('root'));
    });
  }
});
