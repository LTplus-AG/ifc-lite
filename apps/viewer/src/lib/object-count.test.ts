/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createObjectPredicate, countObjects, collectMeshedIds } from './object-count.js';
import { RelationshipType, type DecompositionRelationships } from '@ifc-lite/data';

/**
 * One fixture carrying every case the rule has to separate, so a green run
 * cannot be green merely because the model held none of them:
 *
 * | id | type                     | shape          | object? | why                          |
 * |----|--------------------------|----------------|---------|------------------------------|
 * |  1 | IfcWall                  | own mesh       | yes     | the ordinary case            |
 * |  2 | IfcBuildingElementProxy  | own mesh       | YES     | a proxy is never excluded    |
 * |  3 | IfcBuildingElementProxy  | none           | no      | placement, Representation=$  |
 * |  4 | IfcAnnotation            | own mesh       | no      | passes shape, fails schema   |
 * |  5 | IfcSpace                 | own mesh       | no      | IfcProduct, not IfcElement   |
 * |  6 | IfcOpeningElement        | own mesh       | no      | IfcFeatureElement            |
 * |  7 | IfcRoof                  | via aggregate  | YES     | assembly; parts hold the mesh|
 * |  8 | IfcBeam                  | own mesh       | yes     | #7's aggregated part         |
 * |  9 | IfcGroup                 | none           | no      | not a product at all         |
 * | 10 | IfcVirtualElement        | own mesh       | no      | non-physical clearance       |
 */
const TYPES = new Map<number, string>([
  [1, 'IFCWALL'],
  [2, 'IFCBUILDINGELEMENTPROXY'],
  [3, 'IFCBUILDINGELEMENTPROXY'],
  [4, 'IFCANNOTATION'],
  [5, 'IFCSPACE'],
  [6, 'IFCOPENINGELEMENT'],
  [7, 'IFCROOF'],
  [8, 'IFCBEAM'],
  [9, 'IFCGROUP'],
  [10, 'IFCVIRTUALELEMENT'],
]);

const ALL_IDS = [...TYPES.keys()];

/** Every id but #3 (no representation), #7 (assembly) and #9 (no shape). */
const MESHED = new Set([1, 2, 4, 5, 6, 8, 10]);

/** #7 aggregates #8 — the only decomposition in the fixture. */
const AGGREGATES = new Map<number, number[]>([[7, [8]]]);

const relationships: DecompositionRelationships = {
  getRelated(entityId, type, direction) {
    if (type !== RelationshipType.Aggregates || direction !== 'forward') return [];
    return AGGREGATES.get(entityId) ?? [];
  },
};

function model(overrides: Partial<Parameters<typeof createObjectPredicate>[0]> = {}) {
  return {
    getTypeName: (id: number) => TYPES.get(id),
    relationships,
    meshedIds: MESHED,
    ...overrides,
  };
}

describe('object-count — physical elements that have a shape', () => {
  it('counts exactly the objects in a fixture holding every excluded shape', () => {
    assert.equal(countObjects(ALL_IDS, model()), 4);
  });

  it('admits a proxy WITH geometry and rejects one without — the class is never the discriminator', () => {
    const isObject = createObjectPredicate(model());
    assert.equal(isObject(2), true, 'IfcBuildingElementProxy with a mesh is an object');
    assert.equal(isObject(3), false, 'IfcBuildingElementProxy with Representation=$ is not');
  });

  it('rejects an annotation, which passes the shape test and fails the schema test', () => {
    assert.equal(createObjectPredicate(model())(4), false);
  });

  it('rejects a space, which usually does carry geometry', () => {
    assert.equal(createObjectPredicate(model())(5), false);
  });

  it('rejects openings, virtual elements and groups', () => {
    const isObject = createObjectPredicate(model());
    assert.equal(isObject(6), false);
    assert.equal(isObject(10), false);
    assert.equal(isObject(9), false);
  });

  it('admits an assembly whose mesh lives on an aggregated part', () => {
    assert.equal(createObjectPredicate(model())(7), true);
  });

  it('rejects an assembly whose parts have no geometry either', () => {
    const isObject = createObjectPredicate(model({ meshedIds: new Set([1]) }));
    assert.equal(isObject(7), false, 'IfcRoof aggregating only a mesh-less beam is not an object');
    assert.equal(isObject(1), true);
  });

  it('falls back to the schema test alone before any mesh has arrived', () => {
    // Streaming: no geometry yet. Applying the shape test here would report a
    // model with objects as empty.
    const isObject = createObjectPredicate(model({ meshedIds: new Set<number>() }));
    assert.equal(isObject(3), true, 'shape test is a no-op with no geometry');
    assert.equal(isObject(4), false, 'the schema test still rejects an annotation');
    assert.equal(isObject(9), false, 'and a group');
  });

  it('treats a completed zero-shape result as known-empty', () => {
    const isObject = createObjectPredicate(
      model({ meshedIds: new Set<number>(), geometryReady: true }),
    );
    assert.equal(isObject(1), false, 'a completed model with no shapes has no shaped objects');
  });

  it('rejects an id the store has no type for', () => {
    assert.equal(createObjectPredicate(model())(999), false);
  });

  it('works without a relationship graph', () => {
    const isObject = createObjectPredicate(model({ relationships: undefined }));
    assert.equal(isObject(1), true);
    assert.equal(isObject(7), false, 'no graph means no aggregated shape to find');
  });
});

describe('collectMeshedIds', () => {
  it('dedupes the express ids of a mesh list', () => {
    const ids = collectMeshedIds({ meshes: [{ expressId: 4 }, { expressId: 4 }, { expressId: 9 }] });
    assert.deepEqual([...ids].sort((a, b) => a - b), [4, 9]);
  });

  it('includes instanced-only entities and normalises every geometry channel', () => {
    const ids = collectMeshedIds(
      {
        meshes: [{ expressId: 1_000_004 }],
        instancedGeometryHashes: new Map([[1_000_009, 1n]]),
        instancedGeometryAabbs: new Map([[1_000_010, {}]]),
        instancedGeometryVolumes: new Map([[1_000_011, 1]]),
      },
      (id) => id - 1_000_000,
    );
    assert.deepEqual([...ids].sort((a, b) => a - b), [4, 9, 10, 11]);
  });

  it('is empty for a missing geometry result', () => {
    assert.equal(collectMeshedIds(null).size, 0);
    assert.equal(collectMeshedIds(undefined).size, 0);
    assert.equal(collectMeshedIds({}).size, 0);
  });
});
