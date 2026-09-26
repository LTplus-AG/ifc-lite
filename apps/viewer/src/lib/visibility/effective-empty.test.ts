/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IfcTypeEnum, type SpatialNode } from '@ifc-lite/data';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore, type ViewerState } from '@/store';
import { fixtureModel } from '@/test/store-fixture';

interface VisibilityModule {
  computeVisibilityIsolation(state: ViewerState): Set<number> | null;
  isVisibleResultEmpty(
    state: Pick<ViewerState, 'models' | 'geometryResult' | 'hiddenEntities'>,
    geometry: {
      meshes: ReadonlyArray<{ expressId: number; entityIds?: Uint32Array }> | null;
      pointClouds: ReadonlyArray<{ chunk: { pointCount: number } }>;
      isolatedIds: ReadonlySet<number> | null;
      hasUnenumeratedInstances?: boolean;
    },
  ): boolean;
}

let subject: VisibilityModule;
beforeEach(async () => {
  // The changed-test oracle keeps this test when it reverts production files.
  // A dynamic path lets the test report a failed assertion on that prior tree.
  const path = './effective-empty.js';
  const loaded: unknown = await import(path).catch(() => null);
  assert.ok(loaded !== null && typeof loaded === 'object', 'effective visibility selector exists');
  const exports = loaded as Record<string, unknown>;
  assert.equal(typeof exports.computeVisibilityIsolation, 'function');
  assert.equal(typeof exports.isVisibleResultEmpty, 'function');
  subject = exports as unknown as VisibilityModule;
});

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial));

function model(id: string, offset: number) {
  const entry = fixtureModel(id, { idOffset: offset });
  const storeyA: SpatialNode = {
    expressId: 10, type: IfcTypeEnum.IfcBuildingStorey, name: 'A', children: [], elements: [101],
  };
  const storeyB: SpatialNode = {
    expressId: 20, type: IfcTypeEnum.IfcBuildingStorey, name: 'B', children: [], elements: [102],
  };
  const project: SpatialNode = {
    expressId: 1, type: IfcTypeEnum.IfcProject, name: 'Project', children: [storeyA, storeyB], elements: [],
  };
  entry.ifcDataStore = {
    ...entry.ifcDataStore,
    spatialHierarchy: { project, byStorey: new Map([[10, [101]], [20, [102]]]) },
  } as IfcDataStore;
  entry.maxExpressId = 200;
  entry.geometryResult = {
    meshes: [{ expressId: offset + 101 }, { expressId: offset + 102 }],
    totalTriangles: 2, totalVertices: 6,
  } as GeometryResult;
  return entry;
}

describe('effective empty visibility (#5879)', () => {
  for (const count of [1, 3]) {
    it(`finds a storey A × class-on-B empty intersection in ${count} model(s)`, () => {
      const models = new Map(Array.from({ length: count }, (_, i) => {
        const entry = model(`m${i}`, i * 1000);
        return [entry.id, entry] as const;
      }));
      useViewerStore.setState({
        models,
        selectedStoreys: new Set([10]),
        classFilter: { ids: new Set([...models.values()].map((m) => m.idOffset + 102)), label: 'IfcDoor' },
        isolatedEntities: null,
        hiddenEntities: new Set(),
      });
      const state = useViewerStore.getState();
      const isolatedIds = subject.computeVisibilityIsolation(state);
      assert.deepEqual(isolatedIds, new Set<number>());
      assert.equal(subject.isVisibleResultEmpty(state, {
        meshes: [...models.values()].flatMap((m) => m.geometryResult!.meshes),
        pointClouds: [], isolatedIds,
      }), true);

      useViewerStore.setState({ classFilter: null });
      const resetState = useViewerStore.getState();
      assert.equal(subject.isVisibleResultEmpty(resetState, {
        meshes: [...models.values()].flatMap((m) => m.geometryResult!.meshes),
        pointClouds: [], isolatedIds: subject.computeVisibilityIsolation(resetState),
      }), false, 'removing one filter reveals storey A');
    });

    it(`reports all ${count} loaded model(s) hidden, but no models are not an empty result`, () => {
      const models = new Map(Array.from({ length: count }, (_, i) => {
        const entry = { ...model(`m${i}`, i * 1000), visible: false };
        return [entry.id, entry] as const;
      }));
      useViewerStore.setState({ models, hiddenEntities: new Set() });
      const state = useViewerStore.getState();
      assert.equal(subject.isVisibleResultEmpty(state, { meshes: [], pointClouds: [], isolatedIds: null }), true);
      assert.equal(subject.isVisibleResultEmpty({ models: new Map(), geometryResult: null, hiddenEntities: new Set() },
        { meshes: [], pointClouds: [], isolatedIds: null }), false);
    });
  }

  it('does not call an instanced-only visible model empty when flat meshes are absent', () => {
    const entry = model('m', 0);
    entry.geometryResult = {
      ...entry.geometryResult!, meshes: [], totalTriangles: 2,
      instancedGeometryHashes: new Map([[101, 1n]]),
    };
    const state = { models: new Map([['m', entry]]), geometryResult: null, hiddenEntities: new Set<number>() };
    assert.equal(subject.isVisibleResultEmpty(state, { meshes: [], pointClouds: [], isolatedIds: null }), false);
  });

  it('avoids a false notice for unenumerated GPU shards but accepts a proven empty intersection', () => {
    const entry = model('m', 0);
    entry.geometryResult = { ...entry.geometryResult!, meshes: [] };
    const state = { models: new Map([['m', entry]]), geometryResult: null, hiddenEntities: new Set<number>() };
    assert.equal(subject.isVisibleResultEmpty(state, {
      meshes: [], pointClouds: [], isolatedIds: null, hasUnenumeratedInstances: true,
    }), false);
    assert.equal(subject.isVisibleResultEmpty(state, {
      meshes: [], pointClouds: [], isolatedIds: new Set(), hasUnenumeratedInstances: true,
    }), true);
  });
});
