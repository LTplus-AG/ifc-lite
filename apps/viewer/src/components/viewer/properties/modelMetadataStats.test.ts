/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `computeModelStats` backs the "Elements with Geometry" row in
 * `ModelMetadataPanel`. The fixture reproduces the reported storey — 7
 * `IfcElement`s contained in the storey, one of them (#3) an
 * `IfcBuildingElementProxy` with no representation — so the label's claimed
 * filter is exercised, not just described.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import { computeModelStats } from './modelMetadataStats.js';

const STOREY_ID = 100;

/** 6 real objects (#1-2, #4-7) plus #3 — a proxy with `Representation = $`. */
const TYPES = new Map<number, string>([
  [1, 'IFCWALL'],
  [2, 'IFCBUILDINGELEMENTPROXY'],
  [3, 'IFCBUILDINGELEMENTPROXY'], // no shape — the #4655/#4656/#4658 case
  [4, 'IFCSLAB'],
  [5, 'IFCDOOR'],
  [6, 'IFCWINDOW'],
  [7, 'IFCCOLUMN'],
]);

const BY_TYPE = new Map<string, number[]>();
for (const [id, type] of TYPES) {
  BY_TYPE.set(type, [...(BY_TYPE.get(type) ?? []), id]);
}

function store(overrides: Partial<IfcDataStore> = {}): IfcDataStore {
  return {
    spatialHierarchy: { byStorey: new Map([[STOREY_ID, [...TYPES.keys()]]]) },
    entityIndex: { byType: BY_TYPE },
    relationships: undefined,
    ...overrides,
  } as unknown as IfcDataStore;
}

describe('computeModelStats — "Elements with Geometry"', () => {
  it('matches its label: excludes the physical element with no representation', () => {
    // #1,#2,#4,#5,#6,#7 have meshes; #3 (Representation=$) has none.
    const meshedGlobalIds = new Set([1, 2, 4, 5, 6, 7]);
    const geometryResult = { meshes: [...meshedGlobalIds].map((expressId) => ({ expressId })) } as never;
    const stats = computeModelStats(store(), geometryResult, 0);
    assert.equal(stats.storeys, 1);
    assert.equal(
      stats.elementsWithGeometry,
      6,
      'the reported bug: byStorey.length counted 7, the shape-filtered answer is 6',
    );
  });

  it('counts an instanced-only entity — present only in instancedGeometryHashes, absent from meshes', () => {
    const geometryResult = {
      meshes: [1, 2, 4, 5, 6].map((expressId) => ({ expressId })),
      // #7 was fully GPU-instanced: no entry in `meshes`, only the side channel.
      instancedGeometryHashes: new Map([[7, 0n]]),
    } as never;
    const stats = computeModelStats(store(), geometryResult, 0);
    assert.equal(stats.elementsWithGeometry, 6, 'the instanced column, not just meshes, must be counted');
  });

  it('converts global ids back to model-local before the schema/shape tests, via idOffset', () => {
    const idOffset = 1000;
    const geometryResult = {
      meshes: [1, 2, 4, 5, 6, 7].map((expressId) => ({ expressId: expressId + idOffset })),
    } as never;
    const stats = computeModelStats(store(), geometryResult, idOffset);
    assert.equal(stats.elementsWithGeometry, 6);
  });

  it('shows everything (schema test alone) while a model is still streaming, not zero', () => {
    // No geometry result yet — the "empty means filter inert" contract.
    const stats = computeModelStats(store(), null, 0);
    assert.equal(stats.elementsWithGeometry, 7, 'must not flash 0 before geometry has landed');
  });

  it('reports zero once geometry has completed with no shapes — known-empty, not provisional', () => {
    const stats = computeModelStats(store(), { meshes: [] } as never, 0);
    assert.equal(stats.elementsWithGeometry, 0);
  });

  it('returns zeros when there is no spatial hierarchy at all', () => {
    const stats = computeModelStats(null, null, 0);
    assert.deepEqual(stats, { storeys: 0, elementsWithGeometry: 0 });
  });

  it('excludes a meshed IfcSpace: the schema test, not just the shape test, must run', () => {
    // #8 is IfcSpace — IfcProduct but not IfcElement — carrying a mesh and
    // contained in the storey, same as the real fixture in issue #4655.
    // Passing the shape test alone (it has a mesh) must not be enough: the
    // row would over-read again if `collectPhysicalEntityIds`'s schema
    // filter were ever dropped in favour of the shape test alone.
    const SPACE_ID = 8;
    const byType = new Map(BY_TYPE);
    byType.set('IFCSPACE', [SPACE_ID]);
    const fixture = store({
      spatialHierarchy: { byStorey: new Map([[STOREY_ID, [...TYPES.keys(), SPACE_ID]]]) } as never,
      entityIndex: { byType } as never,
    });
    const meshedGlobalIds = new Set([1, 2, 4, 5, 6, 7, SPACE_ID]);
    const geometryResult = { meshes: [...meshedGlobalIds].map((expressId) => ({ expressId })) } as never;
    const stats = computeModelStats(fixture, geometryResult, 0);
    assert.equal(stats.elementsWithGeometry, 6, 'IfcSpace has a mesh but is not an IfcElement — must stay excluded');
  });
});
