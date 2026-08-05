/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
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

    it('returns false when the isolation is a strict SUPERSET of the basket', () => {
      // The existing "size differs" case only covers isolation SMALLER than
      // the basket, where the membership loop also fails — so the `!==`
      // size check itself was never discriminated and could be weakened to
      // `>` unnoticed. Here every basket id IS isolated but extra elements
      // are isolated too, so only the size check can say "no". Getting this
      // wrong lights up the basket's "isolation active" toggle when the
      // viewport is showing more than the basket.
      useViewerStore.setState({
        pinboardEntities: new Set(['legacy:100']),
        isolatedEntities: new Set([100, 200]),
        models: new Map(),
      });

      assert.strictEqual(isBasketIsolationActiveFromStore(), false);
    });

    it('returns false when sizes match but membership does not', () => {
      useViewerStore.setState({
        pinboardEntities: new Set(['legacy:100', 'legacy:200']),
        isolatedEntities: new Set([100, 999]),
        models: new Map(),
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

    // The two tests above hold whether or not the cache ever invalidates —
    // `deepStrictEqual(first, second)` is exactly as true for a frozen cache
    // as for a correct one. The fingerprint could drop `hiddenEntities`,
    // `isolatedEntities` and `classFilter` outright with the whole
    // apps/viewer suite (2750 tests) still green. What the user sees when it
    // does: hide a wall, press "Add visible to basket", and the wall you just
    // hid lands in the basket anyway.
    describe('the fingerprint reacts to every visibility channel it reads', () => {
      const meshes = [
        { expressId: 1, ifcType: 'IfcWall' },
        { expressId: 2, ifcType: 'IfcWall' },
        { expressId: 3, ifcType: 'IfcWall' },
      ];

      function seedThreeVisibleWalls() {
        useViewerStore.setState({
          selectedEntitiesSet: new Set(),
          selectedEntity: null,
          selectedEntityIds: new Set(),
          hierarchyBasketSelection: new Set(),
          models: new Map(),
          hiddenEntities: new Set(),
          isolatedEntities: null,
          classFilter: null,
          geometryResult: { meshes } as any,
        });
        invalidateVisibleBasketCache();
        const seeded = getVisibleBasketEntityRefsFromStore().map(entityRefToString).sort();
        assert.deepStrictEqual(seeded, ['legacy:1', 'legacy:2', 'legacy:3']);
      }

      it('re-computes after hiddenEntities changes (no explicit invalidate)', () => {
        seedThreeVisibleWalls();
        // Deliberately NOT calling invalidateVisibleBasketCache() — the
        // fingerprint alone has to notice.
        useViewerStore.setState({ hiddenEntities: new Set([2]) });

        assert.deepStrictEqual(
          getVisibleBasketEntityRefsFromStore().map(entityRefToString).sort(),
          ['legacy:1', 'legacy:3'],
        );
      });

      it('re-computes after isolatedEntities changes (no explicit invalidate)', () => {
        seedThreeVisibleWalls();
        useViewerStore.setState({ isolatedEntities: new Set([3]) });

        assert.deepStrictEqual(
          getVisibleBasketEntityRefsFromStore().map(entityRefToString),
          ['legacy:3'],
        );
      });

      it('re-computes after the class filter changes (no explicit invalidate)', () => {
        seedThreeVisibleWalls();
        useViewerStore.setState({ classFilter: { ids: new Set([1]), label: 'IfcWall' } });

        assert.deepStrictEqual(
          getVisibleBasketEntityRefsFromStore().map(entityRefToString),
          ['legacy:1'],
        );
      });

      it('re-computes after per-model hidden entities change (no explicit invalidate)', () => {
        useViewerStore.setState({
          selectedEntitiesSet: new Set(),
          selectedEntity: null,
          selectedEntityIds: new Set(),
          hierarchyBasketSelection: new Set(),
          geometryResult: null,
          hiddenEntities: new Set(),
          isolatedEntities: null,
          classFilter: null,
          hiddenEntitiesByModel: new Map(),
          models: new Map([['m1', { id: 'm1', visible: true, idOffset: 0, maxExpressId: 10, geometryResult: { meshes } } as any]]),
        });
        invalidateVisibleBasketCache();
        assert.strictEqual(getVisibleBasketEntityRefsFromStore().length, 3);

        useViewerStore.setState({ hiddenEntitiesByModel: new Map([['m1', new Set([2])]]) });
        assert.deepStrictEqual(
          getVisibleBasketEntityRefsFromStore().map((r) => r.expressId).sort((a, b) => a - b),
          [1, 3],
        );

        useViewerStore.setState({ models: new Map(), hiddenEntitiesByModel: new Map() });
        invalidateVisibleBasketCache();
      });
    });

    describe('active filters INTERSECT — they do not union', () => {
      it('keeps only the ids present in both the class filter and the isolation', () => {
        // With `some` instead of `every` the two filters would union, so a
        // "isolate these two" + "filter to this class" combination shows
        // MORE than either filter alone — the opposite of what stacking
        // filters means to the user.
        useViewerStore.setState({
          selectedEntitiesSet: new Set(),
          selectedEntity: null,
          selectedEntityIds: new Set(),
          hierarchyBasketSelection: new Set(),
          models: new Map(),
          hiddenEntities: new Set(),
          geometryResult: {
            meshes: [
              { expressId: 1, ifcType: 'IfcWall' },
              { expressId: 2, ifcType: 'IfcWall' },
              { expressId: 3, ifcType: 'IfcWall' },
            ],
          } as any,
          classFilter: { ids: new Set([1, 2]), label: 'IfcWall' },
          isolatedEntities: new Set([2, 3]),
        });
        invalidateVisibleBasketCache();

        assert.deepStrictEqual(
          getVisibleBasketEntityRefsFromStore().map(entityRefToString),
          ['legacy:2'],
        );
      });
    });

    describe('federated per-model gates and offsets', () => {
      // `resetViewerState()` does not clear the federation map, so drop the
      // fixture model explicitly — otherwise it leaks into later suites.
      afterEach(() => {
        useViewerStore.setState({ models: new Map(), hiddenEntitiesByModel: new Map(), isolatedEntitiesByModel: new Map() });
        invalidateVisibleBasketCache();
      });

      /** One model at offset 1000 carrying global meshes 1001..1003. */
      function seedOffsetModel(extra: Record<string, unknown> = {}) {
        useViewerStore.setState({
          selectedEntitiesSet: new Set(),
          selectedEntity: null,
          selectedEntityIds: new Set(),
          hierarchyBasketSelection: new Set(),
          geometryResult: null,
          hiddenEntities: new Set(),
          isolatedEntities: null,
          classFilter: null,
          hiddenEntitiesByModel: new Map(),
          isolatedEntitiesByModel: new Map(),
          models: new Map([['m1', {
            id: 'm1',
            visible: true,
            idOffset: 1000,
            maxExpressId: 100,
            geometryResult: {
              meshes: [
                { expressId: 1001, ifcType: 'IfcWall' },
                { expressId: 1002, ifcType: 'IfcWall' },
                { expressId: 1003, ifcType: 'IfcWall' },
              ],
            },
          } as any]]),
          ...extra,
        } as any);
        invalidateVisibleBasketCache();
      }

      it('maps mesh global ids back to LOCAL express ids through the model offset', () => {
        seedOffsetModel();
        const refs = getVisibleBasketEntityRefsFromStore();
        assert.deepStrictEqual(
          refs.map(entityRefToString).sort(),
          ['m1:1', 'm1:2', 'm1:3'],
        );
      });

      it('applies hiddenEntitiesByModel in the model LOCAL id space, not the global one', () => {
        // The per-model sets are keyed by local expressId. If the candidate
        // carried the global id instead, `hiddenEntitiesByModel` would never
        // match and hiding an element in a federated model would do nothing.
        seedOffsetModel({ hiddenEntitiesByModel: new Map([['m1', new Set([2])]]) });
        assert.deepStrictEqual(
          getVisibleBasketEntityRefsFromStore().map(entityRefToString).sort(),
          ['m1:1', 'm1:3'],
        );
      });

      it('applies isolatedEntitiesByModel in the model LOCAL id space', () => {
        seedOffsetModel({ isolatedEntitiesByModel: new Map([['m1', new Set([3])]]) });
        assert.deepStrictEqual(
          getVisibleBasketEntityRefsFromStore().map(entityRefToString),
          ['m1:3'],
        );
      });

      it('resolves a GLOBAL selected-storey id back into the model local id space', () => {
        // The hierarchy tree sends storey ids in the RENDERER (global) space,
        // but `byStorey` is keyed by the model's local express ids. Dropping
        // the `storeyId - offset` fallback makes storey isolation match
        // nothing in any offset model: pick a storey in the second federated
        // file and the viewport goes empty.
        const storeyLocalId = 4;
        const storeyNode = createNode(storeyLocalId, IfcTypeEnum.IfcBuildingStorey, [], [1, 2]);
        const projectNode = createNode(1, IfcTypeEnum.IfcProject, [storeyNode], []);
        const hierarchy: SpatialHierarchy = {
          project: projectNode,
          byStorey: new Map([[storeyLocalId, [1, 2]]]),
          byBuilding: new Map(),
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

        seedOffsetModel();
        const models = new Map(useViewerStore.getState().models);
        models.set('m1', { ...models.get('m1')!, ifcDataStore: { spatialHierarchy: hierarchy } as any });
        useViewerStore.setState({
          models,
          // 1004 = local storey 4 + the model's 1000 offset.
          selectedStoreys: new Set([1000 + storeyLocalId]),
        });
        invalidateVisibleBasketCache();

        // Only the storey's own elements (local 1 and 2) survive isolation;
        // local 3 is in the model but not in the storey.
        assert.deepStrictEqual(
          getVisibleBasketEntityRefsFromStore().map(entityRefToString).sort(),
          ['m1:1', 'm1:2'],
        );

        // Opposite direction of the same ternary: a storey id that is ALREADY
        // local must be used as-is. Subtracting the offset unconditionally
        // would push it negative and match nothing, so the surfaces that
        // still emit local storey ids would silently isolate to empty.
        useViewerStore.setState({ selectedStoreys: new Set([storeyLocalId]) });
        invalidateVisibleBasketCache();
        assert.deepStrictEqual(
          getVisibleBasketEntityRefsFromStore().map(entityRefToString).sort(),
          ['m1:1', 'm1:2'],
        );

        useViewerStore.setState({ selectedStoreys: new Set() });
      });

      it('skips a model whose visible flag is off', () => {
        seedOffsetModel();
        assert.strictEqual(getVisibleBasketEntityRefsFromStore().length, 3);

        const models = new Map(useViewerStore.getState().models);
        models.set('m1', { ...models.get('m1')!, visible: false });
        useViewerStore.setState({ models });

        assert.strictEqual(getVisibleBasketEntityRefsFromStore().length, 0);
      });
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
