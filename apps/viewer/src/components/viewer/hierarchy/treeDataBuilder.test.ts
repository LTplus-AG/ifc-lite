/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IfcTypeEnum, type SpatialHierarchy, type SpatialNode } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { buildTreeData, buildTypeTree, type AuthoredProduct } from './treeDataBuilder';

function createSpatialNode(
  expressId: number,
  type: IfcTypeEnum,
  name: string,
  children: SpatialNode[] = [],
): SpatialNode {
  return {
    expressId,
    type,
    name,
    children,
    elements: [],
  };
}

function createDataStore(): IfcDataStore {
  const spaceNode = createSpatialNode(5, IfcTypeEnum.IfcSpace, 'e3035b71');
  const storeyNode = createSpatialNode(4, IfcTypeEnum.IfcBuildingStorey, 'MY_STOREY', [spaceNode]);
  const buildingNode = createSpatialNode(3, IfcTypeEnum.IfcBuilding, 'MY_BUILDING', [storeyNode]);
  const siteNode = createSpatialNode(2, IfcTypeEnum.IfcSite, 'MY_SITE', [buildingNode]);
  const projectNode = createSpatialNode(1, IfcTypeEnum.IfcProject, 'MY_PROJECT', [siteNode]);

  const spatialHierarchy: SpatialHierarchy = {
    project: projectNode,
    byStorey: new Map([[4, [6, 7]]]),
    byBuilding: new Map(),
    bySite: new Map(),
    bySpace: new Map([[5, [7]]]),
    storeyElevations: new Map(),
    storeyHeights: new Map(),
    elementToStorey: new Map([[6, 4], [7, 4]]),
    getStoreyElements: () => [],
    getStoreyByElevation: () => null,
    getContainingSpace: (elementId: number) => (elementId === 7 ? 5 : null),
    getPath: () => [],
  };

  return {
    spatialHierarchy,
    entities: {
      count: 0,
      getName: (id: number) => {
        if (id === 6) return 'Wall';
        if (id === 7) return '';
        return '';
      },
      getTypeName: (id: number) => {
        if (id === 6) return 'IfcWall';
        if (id === 7) return 'IfcWindow';
        if (id === 5) return 'IfcSpace';
        return 'Unknown';
      },
    },
  } as unknown as IfcDataStore;
}

function createFacilityDataStore(): IfcDataStore {
  const partNode = createSpatialNode(3, IfcTypeEnum.IfcBridgePart, 'DECK');
  partNode.elements = [4];
  const bridgeNode = createSpatialNode(2, IfcTypeEnum.IfcBridge, 'BRIDGE', [partNode]);
  const projectNode = createSpatialNode(1, IfcTypeEnum.IfcProject, 'INFRA_PROJECT', [bridgeNode]);

  const spatialHierarchy: SpatialHierarchy = {
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

  return {
    spatialHierarchy,
    entities: {
      count: 0,
      getName: (id: number) => (id === 4 ? 'Barrier' : ''),
      getTypeName: (id: number) => {
        if (id === 4) return 'IfcWall';
        return 'Unknown';
      },
    },
  } as unknown as IfcDataStore;
}

function createModel(idOffset: number): FederatedModel {
  return {
    id: 'model-1',
    name: 'Model 1',
    ifcDataStore: createDataStore(),
    geometryResult: { meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: null as never },
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 1,
    idOffset,
    maxExpressId: 7,
  };
}

describe('buildTypeTree — authored (overlay) products', () => {
  // entities.count === 0 so the columnar scan is empty; only the authored
  // fold-in produces nodes — isolating the new path.
  it('folds an authored IfcSpace into its class group and dedups by globalId', () => {
    const ds = createDataStore();
    const authored: AuthoredProduct[] = [
      { modelId: 'legacy', expressId: 900, globalId: 900, name: 'Space 1', ifcType: 'IfcSpace' },
      { modelId: 'legacy', expressId: 900, globalId: 900, name: 'dup', ifcType: 'IfcSpace' },
    ];
    const nodes = buildTypeTree(new Map(), ds, new Set(['type-IfcSpace']), false, new Set([900]), authored);
    const group = nodes.find((n) => n.type === 'type-group' && n.ifcType === 'IfcSpace');
    assert.ok(group, 'an IfcSpace class group exists');
    assert.strictEqual(group.elementCount, 1, 'deduped by globalId');
    const el = nodes.find((n) => n.type !== 'type-group' && n.expressIds[0] === 900);
    assert.ok(el, 'the authored space appears as an element (group expanded)');
    assert.strictEqual(el.name, 'Space 1');
  });

  it('does nothing when there are no authored products', () => {
    const ds = createDataStore();
    const nodes = buildTypeTree(new Map(), ds, new Set(), false, new Set(), []);
    assert.strictEqual(nodes.length, 0);
  });
});

describe('buildTreeData', () => {
  it('keeps IfcSpace as a spatial node, expands bySpace children, and avoids storey duplicates', () => {
    useViewerStore.setState({ models: new Map() });
    useViewerStore.getState().registerModelOffset('tree-test-padding', 99);
    const idOffset = useViewerStore.getState().registerModelOffset('model-1', 7);
    const model = createModel(idOffset);
    useViewerStore.setState({ models: new Map([['model-1', model]]) });

    const models = new Map<string, FederatedModel>([['model-1', model]]);
    const expandedNodes = new Set([
      'root-1',
      'root-1-2',
      'root-1-2-3',
      'root-1-2-3-4',
      'root-1-2-3-4-5',
    ]);

    const nodes = buildTreeData(models, null, expandedNodes, false, []);

    const storeyNode = nodes.find((node) => node.id === 'root-1-2-3-4');
    assert.ok(storeyNode);
    assert.strictEqual(storeyNode.elementCount, 1);

    const spaceNode = nodes.find((node) => node.id === 'root-1-2-3-4-5');
    assert.ok(spaceNode);
    assert.strictEqual(spaceNode.type, 'IfcSpace');
    assert.deepStrictEqual(spaceNode.expressIds, [5]);
    assert.deepStrictEqual(spaceNode.globalIds, [105]);
    assert.strictEqual(spaceNode.elementCount, 1);
    assert.strictEqual(spaceNode.hasChildren, true);

    const windowNode = nodes.find((node) => node.id === 'element-model-1-7');
    assert.ok(windowNode);
    assert.strictEqual(windowNode.type, 'element');
    assert.strictEqual(windowNode.ifcType, 'IfcWindow');
    assert.deepStrictEqual(windowNode.expressIds, [7]);
    assert.deepStrictEqual(windowNode.globalIds, [107]);
    assert.strictEqual(windowNode.name, 'IfcWindow #7');

    assert.strictEqual(nodes.filter((node) => node.id === 'element-model-1-6').length, 1);
    assert.strictEqual(nodes.filter((node) => node.id === 'element-model-1-7').length, 1);
  });

  it('keeps IFC4.3 facility and facility-part nodes as spatial hierarchy rows', () => {
    useViewerStore.setState({ models: new Map() });
    useViewerStore.getState().registerModelOffset('tree-test-infra-padding', 199);
    const idOffset = useViewerStore.getState().registerModelOffset('model-infra', 4);
    const model = {
      ...createModel(idOffset),
      id: 'model-infra',
      name: 'Infra Model',
      ifcDataStore: createFacilityDataStore(),
      maxExpressId: 4,
    };
    useViewerStore.setState({ models: new Map([['model-infra', model]]) });

    const nodes = buildTreeData(
      new Map<string, FederatedModel>([['model-infra', model]]),
      null,
      new Set(['root-1', 'root-1-2', 'root-1-2-3']),
      false,
      [],
    );

    const bridgeNode = nodes.find((node) => node.id === 'root-1-2');
    assert.ok(bridgeNode);
    assert.strictEqual(bridgeNode.type, 'IfcBridge');

    const partNode = nodes.find((node) => node.id === 'root-1-2-3');
    assert.ok(partNode);
    assert.strictEqual(partNode.type, 'IfcBridgePart');
    assert.strictEqual(partNode.elementCount, 1);

    const barrierNode = nodes.find((node) => node.id === 'element-model-infra-4');
    assert.ok(barrierNode);
    assert.strictEqual(barrierNode.type, 'element');
    assert.strictEqual(barrierNode.ifcType, 'IfcWall');
  });
});
