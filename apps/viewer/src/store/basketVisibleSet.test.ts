/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { IfcTypeEnum, RelationshipType, type SpatialHierarchy, type SpatialNode } from '@ifc-lite/data';
import type { AggregationRelationships } from '../utils/aggregation.js';
import {
  collectSpatialSubtreeElementsWithIfcSpace,
  getSmartBasketInputFromStore,
  getBasketSelectionRefsFromStore,
  getVisibleBasketEntityRefsFromStore,
  isBasketIsolationActiveFromStore,
  invalidateVisibleBasketCache,
} from './basketVisibleSet.js';
import { useViewerStore } from './index.js';
import { entityRefToString } from './types.js';

function createNode(expressId: number, type: IfcTypeEnum, children: SpatialNode[] = [], elements: number[] = []): SpatialNode {
  return {
    expressId,
    type,
    name: `Node ${expressId}`,
    children,
    elements,
  };
}

describe('collectSpatialSubtreeElementsWithIfcSpace', () => {
  it('collects direct and descendant IFC4.3 spatial contents for facility-part hierarchies', () => {
    const partNode = createNode(3, IfcTypeEnum.IfcBridgePart, [], [4]);
    const bridgeNode = createNode(2, IfcTypeEnum.IfcBridge, [partNode], []);
    const projectNode = createNode(1, IfcTypeEnum.IfcProject, [bridgeNode], []);

    const hierarchy: SpatialHierarchy = {
      project: projectNode,
      byStorey: new Map(),
      byBuilding: new Map([[2, []]]),
      bySite: new Map(),
      bySpace: new Map(),
      storeyElevations: new Map(),
      storeyHeights: new Map(),
      elementToStorey: new Map(),
      getStoreyElements: () => [],
      getStoreyByElevation: () => null,
      getContainingSpace: () => null,
      getPath: () => [],
    };

    assert.deepEqual(collectSpatialSubtreeElementsWithIfcSpace(hierarchy, 2), [4]);
  });

  it('pulls aggregated assembly parts into a storey when relationships are supplied (issue #1133)', () => {
    // Storey #4 contains an IfcStair #10 whose parts (#11, #12, #13) hang off it
    // via IfcRelAggregates and are NOT directly contained in the storey.
    const storeyNode = createNode(4, IfcTypeEnum.IfcBuildingStorey, [], [10]);
    const buildingNode = createNode(3, IfcTypeEnum.IfcBuilding, [storeyNode], []);
    const projectNode = createNode(1, IfcTypeEnum.IfcProject, [buildingNode], []);

    const hierarchy: SpatialHierarchy = {
      project: projectNode,
      byStorey: new Map([[4, [10]]]),
      byBuilding: new Map(),
      bySite: new Map(),
      bySpace: new Map(),
      storeyElevations: new Map(),
      storeyHeights: new Map(),
      elementToStorey: new Map([[10, 4]]),
      getStoreyElements: () => [],
      getStoreyByElevation: () => null,
      getContainingSpace: () => null,
      getPath: () => [],
    };

    const relationships: AggregationRelationships = {
      getRelated: (id, relType, direction) =>
        relType === RelationshipType.Aggregates && direction === 'forward' && id === 10
          ? [11, 12, 13]
          : [],
    };

    // Without the graph (back-compat): only the stair, parts vanish.
    assert.deepEqual(collectSpatialSubtreeElementsWithIfcSpace(hierarchy, 4), [10]);
    // With the graph: the whole assembly travels with the storey.
    assert.deepEqual(
      collectSpatialSubtreeElementsWithIfcSpace(hierarchy, 4, relationships),
      [10, 11, 12, 13],
    );
  });

  it('keeps the selected container when the spatial subtree has no descendant elements', () => {
    const bridgeNode = createNode(2, IfcTypeEnum.IfcBridge, [], []);
    const projectNode = createNode(1, IfcTypeEnum.IfcProject, [bridgeNode], []);

    const hierarchy: SpatialHierarchy = {
      project: projectNode,
      byStorey: new Map(),
      byBuilding: new Map([[2, []]]),
      bySite: new Map(),
      bySpace: new Map(),
      storeyElevations: new Map(),
      storeyHeights: new Map(),
      elementToStorey: new Map(),
      getStoreyElements: () => [],
      getStoreyByElevation: () => null,
      getContainingSpace: () => null,
      getPath: () => [],
    };

    useViewerStore.setState({
      ifcDataStore: {
        spatialHierarchy: hierarchy,
        entities: { getTypeName: () => 'IfcBridge' },
      } as any,
      selectedEntity: { modelId: 'legacy', expressId: 2 },
      selectedEntities: [],
      selectedEntityIds: new Set(),
      selectedEntitiesSet: new Set(),
    });

    assert.deepEqual(getBasketSelectionRefsFromStore(), [{ modelId: 'legacy', expressId: 2 }]);
  });
});

describe('basketVisibleSet', () => {
  beforeEach(() => {
    invalidateVisibleBasketCache();
    useViewerStore.getState().resetViewerState();
  });

  describe('source priority', () => {
    it('returns selection refs when selectedEntitiesSet has items', () => {
      useViewerStore.setState({
        selectedEntitiesSet: new Set(['legacy:100', 'legacy:200']),
      });

      const result = getSmartBasketInputFromStore();
      assert.strictEqual(result.source, 'selection');
      assert.strictEqual(result.refs.length, 2);
      assert.ok(result.refs.some((r) => entityRefToString(r) === 'legacy:100'));
      assert.ok(result.refs.some((r) => entityRefToString(r) === 'legacy:200'));
    });

    it('returns hierarchy refs when hierarchyBasketSelection has items and no selection', () => {
      useViewerStore.setState({
        selectedEntitiesSet: new Set(),
        selectedEntity: null,
        selectedEntityIds: new Set(),
        hierarchyBasketSelection: new Set(['legacy:300']),
      });

      const result = getSmartBasketInputFromStore();
      assert.strictEqual(result.source, 'hierarchy');
      assert.ok(result.refs.length >= 1);
    });

    it('returns visible refs when only geometry is available', () => {
      useViewerStore.setState({
        selectedEntitiesSet: new Set(),
        selectedEntity: null,
        selectedEntityIds: new Set(),
        hierarchyBasketSelection: new Set(),
        geometryResult: {
          meshes: [
            { expressId: 1, ifcType: 'IfcWall' },
            { expressId: 2, ifcType: 'IfcSlab' },
          ],
        } as any,
      });

      const result = getSmartBasketInputFromStore();
      assert.ok(result.source === 'visible' || result.source === 'empty');
      if (result.source === 'visible') {
        assert.ok(result.refs.length >= 1);
      }
    });

    it('returns empty when no source has refs', () => {
      useViewerStore.setState({
        selectedEntitiesSet: new Set(),
        selectedEntity: null,
        selectedEntityIds: new Set(),
        hierarchyBasketSelection: new Set(),
        geometryResult: null,
      });

      const result = getSmartBasketInputFromStore();
      assert.strictEqual(result.source, 'empty');
      assert.strictEqual(result.refs.length, 0);
    });
  });

  describe('isBasketIsolationActiveFromStore', () => {
    it('returns true when isolated equals basket', () => {
      useViewerStore.setState({
        pinboardEntities: new Set(['legacy:100', 'legacy:200']),
        isolatedEntities: new Set([100, 200]),
        models: new Map(),
      });

      assert.strictEqual(isBasketIsolationActiveFromStore(), true);
    });

    it('returns false when pinboard is empty', () => {
      useViewerStore.setState({
        pinboardEntities: new Set(),
        isolatedEntities: new Set([100]),
      });

      assert.strictEqual(isBasketIsolationActiveFromStore(), false);
    });

    it('returns false when isolated is null', () => {
      useViewerStore.setState({
        pinboardEntities: new Set(['legacy:100']),
        isolatedEntities: null,
      });

      assert.strictEqual(isBasketIsolationActiveFromStore(), false);
    });

    it('returns false when isolated size differs from basket', () => {
      useViewerStore.setState({
        pinboardEntities: new Set(['legacy:100', 'legacy:200']),
        isolatedEntities: new Set([100]),
      });

      assert.strictEqual(isBasketIsolationActiveFromStore(), false);
    });
  });

  describe('visibility cache', () => {
    it('invalidateVisibleBasketCache clears cache', () => {
      useViewerStore.setState({
        geometryResult: { meshes: [{ expressId: 1, ifcType: 'IfcWall' }] } as any,
      });

      const first = getVisibleBasketEntityRefsFromStore();
      invalidateVisibleBasketCache();
      const second = getVisibleBasketEntityRefsFromStore();

      assert.deepStrictEqual(first, second);
    });

    it('returns consistent result on repeated calls with same state', () => {
      useViewerStore.setState({
        geometryResult: { meshes: [{ expressId: 1, ifcType: 'IfcWall' }] } as any,
      });

      const a = getVisibleBasketEntityRefsFromStore();
      const b = getVisibleBasketEntityRefsFromStore();

      assert.deepStrictEqual(a, b);
    });
  });

  describe('type visibility: IfcAnnotation (issue #1354)', () => {
    const meshes = [
      { expressId: 1, ifcType: 'IfcWall' },
      { expressId: 2, ifcType: 'IfcAnnotation' },
    ];

    it('includes IfcAnnotation 3D meshes when the toggle is on', () => {
      useViewerStore.setState({
        selectedEntitiesSet: new Set(),
        selectedEntity: null,
        selectedEntityIds: new Set(),
        hierarchyBasketSelection: new Set(),
        geometryResult: { meshes } as any,
        typeVisibility: { ...useViewerStore.getState().typeVisibility, ifcAnnotations: true },
      });
      invalidateVisibleBasketCache();

      const refs = getVisibleBasketEntityRefsFromStore();
      assert.ok(refs.some((r) => entityRefToString(r) === 'legacy:2'));
    });

    it('drops IfcAnnotation 3D meshes when the toggle is off', () => {
      useViewerStore.setState({
        selectedEntitiesSet: new Set(),
        selectedEntity: null,
        selectedEntityIds: new Set(),
        hierarchyBasketSelection: new Set(),
        geometryResult: { meshes } as any,
        typeVisibility: { ...useViewerStore.getState().typeVisibility, ifcAnnotations: false },
      });
      invalidateVisibleBasketCache();

      const refs = getVisibleBasketEntityRefsFromStore();
      assert.ok(refs.some((r) => entityRefToString(r) === 'legacy:1'));
      assert.ok(!refs.some((r) => entityRefToString(r) === 'legacy:2'));
    });

    it('drops IfcAnnotation 3D meshes on the models (federated) path too', () => {
      // The gate also runs through `state.models` in collectVisibleCandidates,
      // not just the legacy `state.geometryResult` fallback. Lock both paths.
      const model = { visible: true, idOffset: 0, geometryResult: { meshes } } as any;
      useViewerStore.setState({
        selectedEntitiesSet: new Set(),
        selectedEntity: null,
        selectedEntityIds: new Set(),
        hierarchyBasketSelection: new Set(),
        geometryResult: null,
        models: new Map([['m1', model]]),
        typeVisibility: { ...useViewerStore.getState().typeVisibility, ifcAnnotations: false },
      });
      invalidateVisibleBasketCache();

      const refs = getVisibleBasketEntityRefsFromStore();
      assert.ok(refs.some((r) => r.expressId === 1));
      assert.ok(!refs.some((r) => r.expressId === 2));
    });
  });

  describe('federation: unresolved globalId in multi-model', () => {
    it('getBasketSelectionRefsFromStore returns array when models exist', () => {
      useViewerStore.setState({
        selectedEntityIds: new Set([99999]),
        selectedEntitiesSet: new Set(),
        selectedEntity: null,
      });

      const refs = getBasketSelectionRefsFromStore();
      assert.ok(Array.isArray(refs));
    });
  });
});
