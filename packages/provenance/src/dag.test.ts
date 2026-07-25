/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Builds a small (10-node) DAG spanning every node kind and proves the core
 * Merkle property (spec §3.5): changing exactly one leaf's payload flips the
 * hash of every node on the path from that leaf to the root, and NO other
 * node's hash — including sibling branches that share a parent kind but not
 * a parent node.
 *
 * DAG shape (10 nodes):
 *
 *   layer1
 *   ├─ element1  (geometry-mesh: meshA, pset: psetX)
 *   ├─ element2  (geometry-mesh: meshB, pset: psetY, relationship: relVoids)
 *   └─ element3  (geometry-mesh: meshC)                    [unrelated branch]
 *
 *   relVoids references meshA + meshB's hashes directly (a relationship can
 *   reference any node, not just its own element's children).
 *
 * Nodes: meshA, meshB, meshC, psetX, psetY, relVoids, element1, element2,
 * element3, layer1 = 10.
 */

import { describe, expect, it } from 'vitest';
import {
  computeNodeHash,
  type ElementPayload,
  type GeometryMeshPayload,
  type LayerPayload,
  type PropertySetPayload,
  type RelationshipPayload,
} from './node-hash.js';

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

interface Dag {
  meshA: GeometryMeshPayload;
  meshB: GeometryMeshPayload;
  meshC: GeometryMeshPayload;
  psetX: PropertySetPayload;
  psetY: PropertySetPayload;
}

async function buildDagHashes(dag: Dag): Promise<Record<string, string>> {
  const meshAHash = await computeNodeHash('geometry-mesh', dag.meshA);
  const meshBHash = await computeNodeHash('geometry-mesh', dag.meshB);
  const meshCHash = await computeNodeHash('geometry-mesh', dag.meshC);
  const psetXHash = await computeNodeHash('property-set', dag.psetX);
  const psetYHash = await computeNodeHash('property-set', dag.psetY);

  const relVoids: RelationshipPayload = {
    relType: 'IfcRelVoidsElement',
    roles: [
      { roleName: 'RelatingBuildingElement', refs: [meshAHash] },
      { roleName: 'RelatedOpeningElement', refs: [meshBHash] },
    ],
  };
  const relVoidsHash = await computeNodeHash('relationship', relVoids);

  const element1: ElementPayload = {
    key: 'element-1',
    ifcType: 'IfcWall',
    components: [
      { componentKey: 'geometry-mesh', hash: meshAHash },
      { componentKey: 'pset:Pset_WallCommon', hash: psetXHash },
    ],
  };
  const element2: ElementPayload = {
    key: 'element-2',
    ifcType: 'IfcWall',
    components: [
      { componentKey: 'geometry-mesh', hash: meshBHash },
      { componentKey: 'pset:Pset_WallCommon', hash: psetYHash },
      { componentKey: 'relationship:IfcRelVoidsElement', hash: relVoidsHash },
    ],
  };
  const element3: ElementPayload = {
    key: 'element-3',
    ifcType: 'IfcColumn',
    components: [{ componentKey: 'geometry-mesh', hash: meshCHash }],
  };
  const element1Hash = await computeNodeHash('element', element1);
  const element2Hash = await computeNodeHash('element', element2);
  const element3Hash = await computeNodeHash('element', element3);

  const layer1: LayerPayload = { layerId: 'blake3:testlayer', childHashes: [element1Hash, element2Hash, element3Hash] };
  const layer1Hash = await computeNodeHash('layer', layer1);

  return {
    meshA: meshAHash,
    meshB: meshBHash,
    meshC: meshCHash,
    psetX: psetXHash,
    psetY: psetYHash,
    relVoids: relVoidsHash,
    element1: element1Hash,
    element2: element2Hash,
    element3: element3Hash,
    layer1: layer1Hash,
  };
}

function baseDag(): Dag {
  return {
    meshA: mesh(100),
    meshB: mesh(200),
    meshC: mesh(300),
    psetX: { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] },
    psetY: { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: false }] },
  };
}

describe('DAG: 10-node Merkle structure', () => {
  it('has exactly 10 distinct node hashes for a well-formed DAG', async () => {
    const hashes = await buildDagHashes(baseDag());
    expect(Object.keys(hashes)).toHaveLength(10);
    expect(new Set(Object.values(hashes)).size).toBe(10);
  });

  it('a single-leaf change flips exactly the ancestor path (psetX -> element1 -> layer1) and nothing else', async () => {
    const before = await buildDagHashes(baseDag());

    const mutated = baseDag();
    // Change ONE leaf: psetX's IsExternal flips false -> true's opposite.
    mutated.psetX = { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: false }] };
    const after = await buildDagHashes(mutated);

    const changed = new Set<string>();
    for (const key of Object.keys(before)) {
      if (before[key] !== after[key]) changed.add(key);
    }

    // Ancestor path of the changed leaf: psetX itself, element1 (which embeds
    // psetX's hash), and layer1 (which embeds element1's hash).
    expect(changed).toEqual(new Set(['psetX', 'element1', 'layer1']));

    // Everything NOT on that path — including element2's OWN pset (psetY),
    // the relationship, and the sibling element3 branch — must be
    // byte-identical, even though element2 and layer1 share element1 as a
    // sibling/parent respectively.
    expect(after.meshA).toBe(before.meshA);
    expect(after.meshB).toBe(before.meshB);
    expect(after.meshC).toBe(before.meshC);
    expect(after.psetY).toBe(before.psetY);
    expect(after.relVoids).toBe(before.relVoids);
    expect(after.element2).toBe(before.element2);
    expect(after.element3).toBe(before.element3);
  });

  it('a change to a mesh referenced only by the relationship (meshB) flips relVoids, element2, and layer1 — not element1', async () => {
    const before = await buildDagHashes(baseDag());

    const mutated = baseDag();
    mutated.meshB = mesh(201); // different expressId -> different geometry-mesh hash
    const after = await buildDagHashes(mutated);

    const changed = new Set<string>();
    for (const key of Object.keys(before)) {
      if (before[key] !== after[key]) changed.add(key);
    }

    expect(changed).toEqual(new Set(['meshB', 'relVoids', 'element2', 'layer1']));
    expect(after.element1).toBe(before.element1);
    expect(after.element3).toBe(before.element3);
    expect(after.meshA).toBe(before.meshA);
    expect(after.psetX).toBe(before.psetX);
    expect(after.psetY).toBe(before.psetY);
  });

  it('a change to the unrelated element3 branch (meshC) flips only meshC and element3', async () => {
    const before = await buildDagHashes(baseDag());

    const mutated = baseDag();
    mutated.meshC = mesh(301);
    const after = await buildDagHashes(mutated);

    const changed = new Set<string>();
    for (const key of Object.keys(before)) {
      if (before[key] !== after[key]) changed.add(key);
    }

    // element3's change still reaches layer1 (its parent), but nothing in
    // the element1/element2 branches moves.
    expect(changed).toEqual(new Set(['meshC', 'element3', 'layer1']));
    expect(after.element1).toBe(before.element1);
    expect(after.element2).toBe(before.element2);
    expect(after.relVoids).toBe(before.relVoids);
  });
});
