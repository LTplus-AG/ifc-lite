/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { IfcTypeEnum, type SpatialHierarchy, type SpatialNode } from '@ifc-lite/data';
import type { FederatedModel } from './types.js';
import { resolveExportVisibility } from './exportVisibility.js';
import { useViewerStore } from './index.js';

function createNode(expressId: number, type: IfcTypeEnum, children: SpatialNode[] = [], elements: number[] = []): SpatialNode {
  return { expressId, type, name: `Node ${expressId}`, children, elements };
}

/** A minimal `IfcDataStore` stand-in carrying only what the resolver reads:
 *  `entityIndex.byType` (typeVisibility expansion) and, optionally,
 *  `spatialHierarchy` (storey isolation). */
function createDataStore(byType: Record<string, number[]>, spatialHierarchy?: SpatialHierarchy): any {
  return {
    entityIndex: { byType: new Map(Object.entries(byType)) },
    spatialHierarchy,
  };
}

function createFederatedModel(overrides: Partial<FederatedModel> = {}): FederatedModel {
  return {
    id: 'm1',
    name: 'Model 1',
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    fileSize: 0,
    idOffset: 0,
    maxExpressId: 0,
    ...overrides,
  };
}

describe('resolveExportVisibility', () => {
  beforeEach(() => {
    useViewerStore.getState().resetViewerState();
  });

  describe('the #4328 repro: Class tab filter must reach export', () => {
    it('classFilter active -> isolatedLocalIds narrows to the filtered class (single/legacy model)', () => {
      useViewerStore.setState({
        models: new Map(),
        hiddenEntities: new Set(),
        isolatedEntities: null,
        classFilter: { ids: new Set([1, 2]), label: 'IfcWallStandardCase' },
      });

      const result = resolveExportVisibility(useViewerStore.getState(), '__legacy__');

      assert.deepStrictEqual(result.isolatedLocalIds, new Set([1, 2]));
      assert.deepStrictEqual(result.isolatedGlobalIds, new Set([1, 2]));
      assert.deepStrictEqual(result.hiddenLocalIds, new Set());
    });

    it('no filter active -> isolatedLocalIds is null and the full model is unchanged (both directions)', () => {
      useViewerStore.setState({
        models: new Map(),
        hiddenEntities: new Set([5]),
        isolatedEntities: null,
        classFilter: null,
      });

      const result = resolveExportVisibility(useViewerStore.getState(), '__legacy__');

      assert.strictEqual(result.isolatedLocalIds, null);
      assert.deepStrictEqual(result.hiddenLocalIds, new Set([5]));
    });

    it('classFilter narrows a federated model export, converting global ids to local', () => {
      const model = createFederatedModel({ id: 'm1', idOffset: 100, maxExpressId: 50 });
      useViewerStore.setState({
        models: new Map([['m1', model]]),
        hiddenEntities: new Set(),
        hiddenEntitiesByModel: new Map(),
        isolatedEntities: null,
        isolatedEntitiesByModel: new Map(),
        // Global ids 101, 102 belong to model m1 (offset 100); 999 belongs to
        // some other/nonexistent model and must be scoped out.
        classFilter: { ids: new Set([101, 102, 999]), label: 'IfcWallStandardCase' },
      });

      const result = resolveExportVisibility(useViewerStore.getState(), 'm1');

      assert.deepStrictEqual(result.isolatedLocalIds, new Set([1, 2]));
      assert.deepStrictEqual(result.isolatedGlobalIds, new Set([101, 102]));
    });
  });

  describe('typeVisibility (second traced gap: STEP/IFCX never read it)', () => {
    it('hides entities of a type toggled off, and stops hiding once toggled back on', () => {
      const dataStore = createDataStore({ IFCSITE: [7] });
      useViewerStore.setState({
        models: new Map(),
        ifcDataStore: dataStore,
        hiddenEntities: new Set(),
        classFilter: null,
        typeVisibility: { ...useViewerStore.getState().typeVisibility, site: false },
      });

      const hidden = resolveExportVisibility(useViewerStore.getState(), '__legacy__');
      assert.ok(hidden.hiddenLocalIds.has(7), 'IfcSite id must be hidden when the site toggle is off');

      useViewerStore.setState({
        typeVisibility: { ...useViewerStore.getState().typeVisibility, site: true },
      });
      const visible = resolveExportVisibility(useViewerStore.getState(), '__legacy__');
      assert.ok(!visible.hiddenLocalIds.has(7), 'IfcSite id must NOT be hidden once the site toggle is back on');
    });
  });

  describe('ghostExceptEntities is excluded (X-Ray ghosting is not hiding)', () => {
    it('an entity outside ghostExceptEntities is still exported', () => {
      // Seed the entity source: without it entity 2 is never a candidate for
      // hiddenLocalIds and the assertion below would pass vacuously.
      useViewerStore.setState({
        models: new Map(),
        ifcDataStore: createDataStore({ IFCWALL: [1, 2] }),
        hiddenEntities: new Set(),
        classFilter: null,
        // Only entity 1 is "in focus"; 2 renders ghosted/translucent, not hidden.
        ghostExceptEntities: new Set([1]),
      });

      const result = resolveExportVisibility(useViewerStore.getState(), '__legacy__');
      assert.ok(!result.hiddenLocalIds.has(2), 'a ghosted (not hidden) entity must still export');
      assert.strictEqual(result.isolatedLocalIds, null);
    });
  });

  describe('composition: storey selection ∩ classFilter, not union', () => {
    it('intersects an active storey selection with an active class filter', () => {
      // Storey #10 contains elements 1 (a wall) and 2 (a door).
      const storeyNode = createNode(10, IfcTypeEnum.IfcBuildingStorey, [], [1, 2]);
      const buildingNode = createNode(3, IfcTypeEnum.IfcBuilding, [storeyNode], []);
      const projectNode = createNode(4, IfcTypeEnum.IfcProject, [buildingNode], []);
      const hierarchy: SpatialHierarchy = {
        project: projectNode,
        byStorey: new Map([[10, [1, 2]]]),
        byBuilding: new Map(),
        bySite: new Map(),
        bySpace: new Map(),
        storeyElevations: new Map(),
        storeyHeights: new Map(),
        elementToStorey: new Map([[1, 10], [2, 10]]),
        getStoreyElements: () => [],
        getStoreyByElevation: () => null,
        getContainingSpace: () => null,
        getPath: () => [],
      };

      useViewerStore.setState({
        models: new Map(),
        ifcDataStore: createDataStore({}, hierarchy),
        hiddenEntities: new Set(),
        selectedStoreys: new Set([10]),
        // The Class tab is filtered to just the wall (id 1) — the door (id 2)
        // is on the selected storey but not in the class filter.
        classFilter: { ids: new Set([1]), label: 'IfcWallStandardCase' },
      });

      const result = resolveExportVisibility(useViewerStore.getState(), '__legacy__');

      // Intersection: only id 1 survives, not the union {1, 2}.
      assert.deepStrictEqual(result.isolatedLocalIds, new Set([1]));
    });
  });
});
