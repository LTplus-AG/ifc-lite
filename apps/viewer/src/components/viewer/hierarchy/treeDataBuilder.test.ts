/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IfcTypeEnum, RelationshipType, type SpatialHierarchy, type SpatialNode } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import {
  buildTreeData,
  buildTypeTree,
  buildUnifiedStoreys,
  compareStoreyEntries,
  buildGroupTree,
  resolveMemberGeometry,
  groupMatchesSubFilter,
  GROUP_ENTITY_TYPES,
  type AuthoredProduct,
} from './treeDataBuilder';
import type { HierarchySortMode } from './types';

function createSpatialNode(
  expressId: number,
  type: IfcTypeEnum,
  name: string,
  children: SpatialNode[] = [],
  longName?: string,
): SpatialNode {
  return {
    expressId,
    type,
    name,
    longName,
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

/** Storey #4 contains an IfcStair #10 that decomposes (IfcRelAggregates) into a
 *  stair flight #11 and a railing #12 — neither part is directly contained in
 *  the storey. Mirrors the issue #1133 file. Legacy mode → globalId === expressId. */
function createAssemblyDataStore(): IfcDataStore {
  const storeyNode = createSpatialNode(4, IfcTypeEnum.IfcBuildingStorey, 'GROUND');
  const buildingNode = createSpatialNode(3, IfcTypeEnum.IfcBuilding, 'MY_BUILDING', [storeyNode]);
  const siteNode = createSpatialNode(2, IfcTypeEnum.IfcSite, 'MY_SITE', [buildingNode]);
  const projectNode = createSpatialNode(1, IfcTypeEnum.IfcProject, 'MY_PROJECT', [siteNode]);

  const spatialHierarchy: SpatialHierarchy = {
    project: projectNode,
    byStorey: new Map([[4, [10]]]), // only the stair is contained, not its parts
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

  const names: Record<number, string> = {
    10: 'Stair', 11: 'Flight', 12: 'Railing',
  };
  const types: Record<number, string> = {
    10: 'IfcStair', 11: 'IfcStairFlight', 12: 'IfcRailing',
  };

  return {
    spatialHierarchy,
    entities: {
      count: 0,
      getName: (id: number) => names[id] ?? '',
      getTypeName: (id: number) => types[id] ?? 'Unknown',
    },
    relationships: {
      getRelated: (id: number, relType: RelationshipType, direction: 'forward' | 'inverse') => {
        if (relType === RelationshipType.Aggregates && direction === 'forward' && id === 10) {
          return [11, 12];
        }
        return [];
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

  it('nests an assembly stair under the storey and exposes its parts (issue #1133)', () => {
    useViewerStore.setState({ models: new Map() });
    const ds = createAssemblyDataStore();

    // Storey expanded but the stair collapsed: it must still advertise children
    // and carry its parts for one-click highlight/isolate.
    const collapsed = buildTreeData(new Map(), ds, new Set(['root-1', 'root-1-2', 'root-1-2-3', 'root-1-2-3-4']), false, []);
    const stair = collapsed.find((n) => n.id === 'element-legacy-10');
    assert.ok(stair, 'stair appears under the storey');
    assert.strictEqual(stair.ifcType, 'IfcStair');
    assert.strictEqual(stair.hasChildren, true, 'assembly is expandable');
    assert.strictEqual(stair.elementCount, 2, 'badge shows direct part count');
    assert.deepStrictEqual(stair.assemblyChildGlobalIds, [11, 12], 'parts carried for highlight/isolate');
    // Parts are hidden until the stair row itself is expanded.
    assert.strictEqual(collapsed.some((n) => n.id === 'element-legacy-11'), false);

    // Expand the stair → its parts become nested rows one level deeper.
    const expanded = buildTreeData(
      new Map(),
      ds,
      new Set(['root-1', 'root-1-2', 'root-1-2-3', 'root-1-2-3-4', 'element-legacy-10']),
      false,
      [],
    );
    const flight = expanded.find((n) => n.id === 'element-legacy-11');
    const railing = expanded.find((n) => n.id === 'element-legacy-12');
    assert.ok(flight && railing, 'both parts render when the assembly is expanded');
    assert.strictEqual(flight.ifcType, 'IfcStairFlight');
    assert.strictEqual(railing.ifcType, 'IfcRailing');
    assert.strictEqual(flight.depth, stair.depth + 1, 'parts nest one level under the assembly');
    assert.strictEqual(flight.hasChildren, false, 'leaf parts are not expandable');
  });
});

/** ISO 19650 spatial structure: buildings carry a short code in Name and the
 *  descriptive label in LongName. #3 "01"/"Main Residence" (distinct), #7
 *  "02"/"Garage" (distinct), #8 "Annex"/"Annex" (duplicate — no secondary). */
function createLongNameDataStore(): IfcDataStore {
  const residence = createSpatialNode(3, IfcTypeEnum.IfcBuilding, '01', [], 'Main Residence');
  const garage = createSpatialNode(7, IfcTypeEnum.IfcBuilding, '02', [], 'Garage & Workshop');
  const annex = createSpatialNode(8, IfcTypeEnum.IfcBuilding, 'Annex', [], 'Annex');
  const siteNode = createSpatialNode(2, IfcTypeEnum.IfcSite, 'MY_SITE', [residence, garage, annex]);
  const projectNode = createSpatialNode(1, IfcTypeEnum.IfcProject, 'MY_PROJECT', [siteNode]);

  const spatialHierarchy: SpatialHierarchy = {
    project: projectNode,
    byStorey: new Map(),
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

  return {
    spatialHierarchy,
    entities: { count: 0, getName: () => '', getTypeName: () => 'Unknown' },
  } as unknown as IfcDataStore;
}

describe('spatial short + long name (#1634)', () => {
  const expanded = new Set(['root-1', 'root-1-2']);

  it('exposes LongName as secondaryName alongside the short Name', () => {
    const nodes = buildTreeData(new Map(), createLongNameDataStore(), expanded, false, []);

    const residence = nodes.find((n) => n.id === 'root-1-2-3')!;
    assert.strictEqual(residence.name, '01');
    assert.strictEqual(residence.secondaryName, 'Main Residence');

    const garage = nodes.find((n) => n.id === 'root-1-2-7')!;
    assert.strictEqual(garage.name, '02');
    assert.strictEqual(garage.secondaryName, 'Garage & Workshop');
  });

  it('drops a LongName that just duplicates the Name (no redundant secondary)', () => {
    const nodes = buildTreeData(new Map(), createLongNameDataStore(), expanded, false, []);
    const annex = nodes.find((n) => n.id === 'root-1-2-8')!;
    assert.strictEqual(annex.name, 'Annex');
    assert.strictEqual(annex.secondaryName, undefined);
  });

  it('leaves secondaryName undefined when a node carries no LongName', () => {
    const nodes = buildTreeData(new Map(), createLongNameDataStore(), expanded, false, []);
    const site = nodes.find((n) => n.id === 'root-1-2')!;
    assert.strictEqual(site.secondaryName, undefined);
  });
});

/** Three storeys whose names deliberately don't track elevation, so each sort
 *  mode produces a distinct order. Storey express ids: 4 = "Level 10" @ 0m,
 *  5 = "Level 2" @ 6m, 6 = "Level 1" @ 3m. Children are listed 4,5,6. */
function createSortStoreyDataStore(): IfcDataStore {
  const s10 = createSpatialNode(4, IfcTypeEnum.IfcBuildingStorey, 'Level 10');
  s10.elevation = 0;
  const s2 = createSpatialNode(5, IfcTypeEnum.IfcBuildingStorey, 'Level 2');
  s2.elevation = 6;
  const s1 = createSpatialNode(6, IfcTypeEnum.IfcBuildingStorey, 'Level 1');
  s1.elevation = 3;
  const buildingNode = createSpatialNode(3, IfcTypeEnum.IfcBuilding, 'MY_BUILDING', [s10, s2, s1]);
  const siteNode = createSpatialNode(2, IfcTypeEnum.IfcSite, 'MY_SITE', [buildingNode]);
  const projectNode = createSpatialNode(1, IfcTypeEnum.IfcProject, 'MY_PROJECT', [siteNode]);

  const spatialHierarchy: SpatialHierarchy = {
    project: projectNode,
    byStorey: new Map([[4, []], [5, []], [6, []]]),
    byBuilding: new Map(),
    bySite: new Map(),
    bySpace: new Map(),
    storeyElevations: new Map([[4, 0], [5, 6], [6, 3]]),
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
      getName: () => '',
      getTypeName: () => 'Unknown',
    },
  } as unknown as IfcDataStore;
}

describe('storey sort order (#1296)', () => {
  // Expand project/site/building so the storey children are emitted in sorted order.
  const expanded = new Set(['root-1', 'root-1-2', 'root-1-2-3']);

  function storeyOrder(sortMode: HierarchySortMode): number[] {
    const nodes = buildTreeData(new Map(), createSortStoreyDataStore(), expanded, false, [], sortMode);
    return nodes
      .filter((n) => n.type === 'IfcBuildingStorey')
      .map((n) => n.expressIds[0]);
  }

  it('defaults to elevation, highest first', () => {
    // No explicit mode → previous behaviour preserved.
    const nodes = buildTreeData(new Map(), createSortStoreyDataStore(), expanded, false, []);
    const order = nodes.filter((n) => n.type === 'IfcBuildingStorey').map((n) => n.expressIds[0]);
    assert.deepStrictEqual(order, [5, 6, 4]);
  });

  it('elevation-desc orders highest elevation first', () => {
    assert.deepStrictEqual(storeyOrder('elevation-desc'), [5, 6, 4]);
  });

  it('elevation-asc orders lowest elevation first', () => {
    assert.deepStrictEqual(storeyOrder('elevation-asc'), [4, 6, 5]);
  });

  it('name-asc sorts alphanumerically with natural numeric order (Level 2 before Level 10)', () => {
    assert.deepStrictEqual(storeyOrder('name-asc'), [6, 5, 4]);
  });

  it('name-desc reverses the alphanumeric order', () => {
    assert.deepStrictEqual(storeyOrder('name-desc'), [4, 5, 6]);
  });
});

describe('compareStoreyEntries', () => {
  it('treats missing elevation as 0', () => {
    const a = { name: 'A' };
    const b = { name: 'B', elevation: 5 };
    // desc: b (5) before a (0) → positive when comparing (a, b)
    assert.ok(compareStoreyEntries(a, b, 'elevation-desc') > 0);
    assert.ok(compareStoreyEntries(a, b, 'elevation-asc') < 0);
  });

  it('name sort is case-insensitive', () => {
    assert.strictEqual(compareStoreyEntries({ name: 'roof' }, { name: 'ROOF' }, 'name-asc'), 0);
  });
});

/** IFC4.3 facility with three IfcFacilityPart rows named "Part 10/2/1"
 *  (express ids 4/5/6), listed 4,5,6 under an IfcFacility. */
function createFacilityPartsDataStore(): IfcDataStore {
  const p10 = createSpatialNode(4, IfcTypeEnum.IfcFacilityPart, 'Part 10');
  const p2 = createSpatialNode(5, IfcTypeEnum.IfcFacilityPart, 'Part 2');
  const p1 = createSpatialNode(6, IfcTypeEnum.IfcFacilityPart, 'Part 1');
  const facilityNode = createSpatialNode(2, IfcTypeEnum.IfcFacility, 'FACILITY', [p10, p2, p1]);
  const projectNode = createSpatialNode(1, IfcTypeEnum.IfcProject, 'PROJECT', [facilityNode]);

  const spatialHierarchy: SpatialHierarchy = {
    project: projectNode,
    byStorey: new Map(),
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

  return {
    spatialHierarchy,
    entities: { count: 0, getName: () => '', getTypeName: () => 'Unknown' },
  } as unknown as IfcDataStore;
}

/** A building with mixed children: storey "Level B" (4), space "Atrium" (5),
 *  storey "Level A" (6) — listed 4,5,6. The space is a non-level sibling. */
function createMixedChildrenDataStore(): IfcDataStore {
  const sB = createSpatialNode(4, IfcTypeEnum.IfcBuildingStorey, 'Level B');
  sB.elevation = 0;
  const space = createSpatialNode(5, IfcTypeEnum.IfcSpace, 'Atrium');
  const sA = createSpatialNode(6, IfcTypeEnum.IfcBuildingStorey, 'Level A');
  sA.elevation = 0;
  const buildingNode = createSpatialNode(3, IfcTypeEnum.IfcBuilding, 'MY_BUILDING', [sB, space, sA]);
  const siteNode = createSpatialNode(2, IfcTypeEnum.IfcSite, 'MY_SITE', [buildingNode]);
  const projectNode = createSpatialNode(1, IfcTypeEnum.IfcProject, 'MY_PROJECT', [siteNode]);

  const spatialHierarchy: SpatialHierarchy = {
    project: projectNode,
    byStorey: new Map([[4, []], [6, []]]),
    byBuilding: new Map(),
    bySite: new Map(),
    bySpace: new Map([[5, []]]),
    storeyElevations: new Map([[4, 0], [6, 0]]),
    storeyHeights: new Map(),
    elementToStorey: new Map(),
    getStoreyElements: () => [],
    getStoreyByElevation: () => null,
    getContainingSpace: () => null,
    getPath: () => [],
  };

  return {
    spatialHierarchy,
    entities: { count: 0, getName: () => '', getTypeName: () => 'Unknown' },
  } as unknown as IfcDataStore;
}

/** One storey "GROUND" (#4) containing three named walls whose document order
 *  (8, 7, 9) tracks neither name nor id, so each sort mode yields a distinct
 *  order. Names: 7 = "Wall 10", 8 = "Wall 2", 9 = "Wall 1". */
function createStoreyElementsDataStore(): IfcDataStore {
  const storeyNode = createSpatialNode(4, IfcTypeEnum.IfcBuildingStorey, 'GROUND');
  storeyNode.elevation = 0;
  const buildingNode = createSpatialNode(3, IfcTypeEnum.IfcBuilding, 'MY_BUILDING', [storeyNode]);
  const siteNode = createSpatialNode(2, IfcTypeEnum.IfcSite, 'MY_SITE', [buildingNode]);
  const projectNode = createSpatialNode(1, IfcTypeEnum.IfcProject, 'MY_PROJECT', [siteNode]);

  const spatialHierarchy: SpatialHierarchy = {
    project: projectNode,
    byStorey: new Map([[4, [8, 7, 9]]]), // document order: 8, 7, 9
    byBuilding: new Map(),
    bySite: new Map(),
    bySpace: new Map(),
    storeyElevations: new Map([[4, 0]]),
    storeyHeights: new Map(),
    elementToStorey: new Map([[7, 4], [8, 4], [9, 4]]),
    getStoreyElements: () => [],
    getStoreyByElevation: () => null,
    getContainingSpace: () => null,
    getPath: () => [],
  };

  const names: Record<number, string> = { 7: 'Wall 10', 8: 'Wall 2', 9: 'Wall 1' };
  return {
    spatialHierarchy,
    entities: {
      count: 0,
      getName: (id: number) => names[id] ?? '',
      getTypeName: () => 'IfcWall',
    },
  } as unknown as IfcDataStore;
}

/** A stair #10 aggregating THREE parts whose document order [11, 12, 13] tracks
 *  neither name-asc nor name-desc, so both directions prove the recursion sorts
 *  (a two-part fixture where asc happens to equal document order would leave the
 *  asc assertion tautological). Names: 11 = "M-mid", 12 = "A-first", 13 = "Z-last". */
function createSortAssemblyDataStore(): IfcDataStore {
  const storeyNode = createSpatialNode(4, IfcTypeEnum.IfcBuildingStorey, 'GROUND');
  const buildingNode = createSpatialNode(3, IfcTypeEnum.IfcBuilding, 'MY_BUILDING', [storeyNode]);
  const siteNode = createSpatialNode(2, IfcTypeEnum.IfcSite, 'MY_SITE', [buildingNode]);
  const projectNode = createSpatialNode(1, IfcTypeEnum.IfcProject, 'MY_PROJECT', [siteNode]);

  const spatialHierarchy: SpatialHierarchy = {
    project: projectNode,
    byStorey: new Map([[4, [10]]]), // only the stair is contained; parts hang off it
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

  const names: Record<number, string> = { 10: 'Stair', 11: 'M-mid', 12: 'A-first', 13: 'Z-last' };
  const types: Record<number, string> = {
    10: 'IfcStair', 11: 'IfcRailing', 12: 'IfcStairFlight', 13: 'IfcRailing',
  };

  return {
    spatialHierarchy,
    entities: {
      count: 0,
      getName: (id: number) => names[id] ?? '',
      getTypeName: (id: number) => types[id] ?? 'Unknown',
    },
    relationships: {
      getRelated: (id: number, relType: RelationshipType, direction: 'forward' | 'inverse') =>
        relType === RelationshipType.Aggregates && direction === 'forward' && id === 10
          ? [11, 12, 13]
          : [],
    },
  } as unknown as IfcDataStore;
}

/** One storey "GROUND" (#4) at elevation 0 holding the given element ids, used to
 *  build a federated (multi-model) scenario. Names drive the in-storey sort. */
function createSortStoreyModelDataStore(
  elements: number[],
  names: Record<number, string>,
): IfcDataStore {
  const storeyNode = createSpatialNode(4, IfcTypeEnum.IfcBuildingStorey, 'GROUND');
  storeyNode.elevation = 0;
  const buildingNode = createSpatialNode(3, IfcTypeEnum.IfcBuilding, 'MY_BUILDING', [storeyNode]);
  const siteNode = createSpatialNode(2, IfcTypeEnum.IfcSite, 'MY_SITE', [buildingNode]);
  const projectNode = createSpatialNode(1, IfcTypeEnum.IfcProject, 'MY_PROJECT', [siteNode]);

  const spatialHierarchy: SpatialHierarchy = {
    project: projectNode,
    byStorey: new Map([[4, elements]]),
    byBuilding: new Map(),
    bySite: new Map(),
    bySpace: new Map(),
    storeyElevations: new Map([[4, 0]]),
    storeyHeights: new Map(),
    elementToStorey: new Map(elements.map((e) => [e, 4] as const)),
    getStoreyElements: () => [],
    getStoreyByElevation: () => null,
    getContainingSpace: () => null,
    getPath: () => [],
  };

  return {
    spatialHierarchy,
    entities: {
      count: 0,
      getName: (id: number) => names[id] ?? '',
      getTypeName: () => 'IfcWall',
    },
  } as unknown as IfcDataStore;
}

describe('element sort within a storey (#1476)', () => {
  // Storey (and its ancestors) expanded so the contained elements are emitted.
  const expanded = new Set(['root-1', 'root-1-2', 'root-1-2-3', 'root-1-2-3-4']);

  function elementOrder(sortMode?: HierarchySortMode): number[] {
    const nodes = buildTreeData(new Map(), createStoreyElementsDataStore(), expanded, false, [], sortMode);
    return nodes.filter((n) => n.type === 'element').map((n) => n.expressIds[0]);
  }

  it('keeps document order for elements in elevation mode (default behaviour)', () => {
    assert.deepStrictEqual(elementOrder('elevation-desc'), [8, 7, 9]);
    assert.deepStrictEqual(elementOrder('elevation-asc'), [8, 7, 9]);
    // No explicit mode → default (elevation-desc) → document order preserved.
    assert.deepStrictEqual(elementOrder(), [8, 7, 9]);
  });

  it('name-asc sorts elements inside the storey by name, natural-numeric', () => {
    // Wall 1(9), Wall 2(8), Wall 10(7) — reaches inside the storey (#1476).
    assert.deepStrictEqual(elementOrder('name-asc'), [9, 8, 7]);
  });

  it('name-desc reverses the in-storey element order', () => {
    assert.deepStrictEqual(elementOrder('name-desc'), [7, 8, 9]);
  });

  it("sorts a decomposing assembly's parts by name when a name sort is active", () => {
    useViewerStore.setState({ models: new Map() });
    const ds = createSortAssemblyDataStore();
    const stairExpanded = new Set([
      'root-1', 'root-1-2', 'root-1-2-3', 'root-1-2-3-4', 'element-legacy-10',
    ]);
    const partOrder = (mode: HierarchySortMode): number[] =>
      buildTreeData(new Map(), ds, stairExpanded, false, [], mode)
        .filter((n) => n.type === 'element' && [11, 12, 13].includes(n.expressIds[0]))
        .map((n) => n.expressIds[0]);
    // Parts document order is [11 "M-mid", 12 "A-first", 13 "Z-last"] — chosen so
    // BOTH sort directions differ from it, so neither assertion is tautological.
    assert.deepStrictEqual(partOrder('name-asc'), [12, 11, 13], 'A-first, M-mid, Z-last');
    assert.deepStrictEqual(partOrder('name-desc'), [13, 11, 12], 'Z-last, M-mid, A-first');
    assert.deepStrictEqual(partOrder('elevation-desc'), [11, 12, 13], 'elevation keeps document order');
  });

  it('sorts elements inside a federated (multi-model) storey contribution (#1476)', () => {
    // Exercises the multi-model unified-storey contribution loop (the third
    // orderElementIdsByName call site), which the single-model tests never reach.
    useViewerStore.setState({ models: new Map() });
    const offA = useViewerStore.getState().registerModelOffset('sort-fed-A', 20);
    const offB = useViewerStore.getState().registerModelOffset('sort-fed-B', 20);
    const modelA: FederatedModel = {
      ...createModel(offA),
      id: 'sort-fed-A',
      name: 'Model A',
      ifcDataStore: createSortStoreyModelDataStore([8, 7, 9], { 7: 'Wall 10', 8: 'Wall 2', 9: 'Wall 1' }),
      maxExpressId: 9,
    };
    const modelB: FederatedModel = {
      ...createModel(offB),
      id: 'sort-fed-B',
      name: 'Model B',
      ifcDataStore: createSortStoreyModelDataStore([5], { 5: 'Solo' }),
      maxExpressId: 5,
    };
    const models = new Map<string, FederatedModel>([['sort-fed-A', modelA], ['sort-fed-B', modelB]]);
    useViewerStore.setState({ models });

    const unified = buildUnifiedStoreys(models, 'name-asc');
    // Both storeys sit at elevation 0, so they merge into one unified storey.
    assert.strictEqual(unified.length, 1, 'storeys at the same elevation unify');

    const expanded = new Set([`unified-${unified[0].key}`, 'contrib-sort-fed-A-4']);
    const nodes = buildTreeData(models, null, expanded, true, unified, 'name-asc');

    const orderA = nodes
      .filter((n) => n.type === 'element' && n.id.startsWith('element-sort-fed-A-'))
      .map((n) => n.expressIds[0]);
    // Model A doc order [8, 7, 9] → name-asc Wall 1(9), Wall 2(8), Wall 10(7).
    assert.deepStrictEqual(orderA, [9, 8, 7], 'contribution elements sort by name inside a federated storey');
  });
});

describe('storey sort order — IFC4.3 parts and non-level siblings (#1296)', () => {
  it('sorts IfcFacilityPart rows, not just IfcBuildingStorey', () => {
    const nodes = buildTreeData(
      new Map(),
      createFacilityPartsDataStore(),
      new Set(['root-1', 'root-1-2']),
      false,
      [],
      'name-asc',
    );
    const order = nodes.filter((n) => n.type === 'IfcFacilityPart').map((n) => n.expressIds[0]);
    // Part 1, Part 2, Part 10 (natural numeric) → ids 6, 5, 4
    assert.deepStrictEqual(order, [6, 5, 4]);
  });

  it('keeps a non-level sibling (IfcSpace) in its original slot while sorting storeys', () => {
    const nodes = buildTreeData(
      new Map(),
      createMixedChildrenDataStore(),
      new Set(['root-1', 'root-1-2', 'root-1-2-3']),
      false,
      [],
      'name-asc',
    );
    const order = nodes
      .filter((n) => (n.type === 'IfcBuildingStorey' || n.type === 'IfcSpace') && n.id.startsWith('root-1-2-3-'))
      .map((n) => n.expressIds[0]);
    // Storeys A(6)/B(4) reorder by name; the space (5) stays in the middle slot.
    assert.deepStrictEqual(order, [6, 5, 4]);
  });
});

// ============================================================================
// Groups tab — buildGroupTree / resolveMemberGeometry (#1622)
// ============================================================================

/**
 * A minimal MEP-shaped store for the Groups tab. Legacy mode → globalId ===
 * expressId, so `geometricIds` are plain express ids.
 *
 *  - IfcDistributionSystem #100 "HVAC System": ports #201/#203 (no geometry) +
 *    duct #202 (geometry). Both ports NEST under #202 (IfcRelNests → the shared
 *    Aggregates edge bucket, inverse direction).
 *  - IfcZone #300 (unnamed, ObjectType "Fire Compartment"): spaces #301/#302.
 *  - IfcGroup #400 "Misc": duct #202 again (many-to-many) + orphan port #999
 *    (no geometry, no relatives → select-only row).
 *  - IfcSystem #500 "Empty": no members → skipped.
 *
 * Note #100 is an IfcDistributionSystem, NOT an IfcSystem: an exact-match
 * `byType.get('IFCSYSTEM')` returns only #500, so the tab must enumerate the
 * subtype explicitly (the #1662 defect class).
 */
function createGroupDataStore(): IfcDataStore {
  const names: Record<number, string> = {
    100: 'HVAC System', 300: '', 400: 'Misc', 500: 'Empty', 600: 'Lighting Circuit',
    201: 'Port A', 202: 'Main Duct', 203: 'Port B',
    301: 'Room 1', 302: 'Room 2', 999: 'Orphan Port',
  };
  const types: Record<number, string> = {
    100: 'IfcDistributionSystem', 300: 'IfcZone', 400: 'IfcGroup', 500: 'IfcSystem',
    600: 'IfcDistributionCircuit',
    201: 'IfcDistributionPort', 202: 'IfcDuctSegment', 203: 'IfcDistributionPort',
    301: 'IfcSpace', 302: 'IfcSpace', 999: 'IfcDistributionPort',
  };
  const objectTypes: Record<number, string> = { 300: 'Fire Compartment' };

  const byType = new Map<string, number[]>([
    ['IFCDISTRIBUTIONSYSTEM', [100]],
    ['IFCDISTRIBUTIONCIRCUIT', [600]],
    ['IFCZONE', [300]],
    ['IFCGROUP', [400]],
    ['IFCSYSTEM', [500]],
  ]);
  const byId = new Map<number, { type: string }>();
  for (const id of Object.keys(types)) byId.set(Number(id), { type: types[Number(id)].toUpperCase() });

  const members: Record<number, number[]> = {
    100: [201, 202, 203],
    300: [301, 302],
    400: [202, 999],
    500: [],
    600: [202],
  };
  // IfcRelNests: ports #201/#203 nest under duct #202 (inverse → parent host).
  const nestParent: Record<number, number[]> = { 201: [202], 203: [202] };

  return {
    entityIndex: { byType, byId },
    entities: {
      count: 0,
      getName: (id: number) => names[id] ?? '',
      getTypeName: (id: number) => types[id] ?? 'Unknown',
      getObjectType: (id: number) => objectTypes[id] ?? '',
    },
    relationships: {
      getRelated: (id: number, relType: RelationshipType, direction: 'forward' | 'inverse') => {
        if (relType === RelationshipType.AssignsToGroup && direction === 'forward') {
          return members[id] ?? [];
        }
        if (relType === RelationshipType.Aggregates && direction === 'inverse') {
          return nestParent[id] ?? [];
        }
        return [];
      },
    },
  } as unknown as IfcDataStore;
}

const GROUP_GEO_IDS = new Set<number>([202, 301, 302]);

const toLegacyGlobal = (id: number) => id;

describe('resolveMemberGeometry (#1622)', () => {
  it('passes a geometry-bearing member through as itself', () => {
    const ds = createGroupDataStore();
    const resolved = resolveMemberGeometry(ds, 202, toLegacyGlobal, GROUP_GEO_IDS);
    assert.deepStrictEqual(resolved, [{ expressId: 202, globalId: 202 }]);
  });

  it('resolves a geometry-less port to its nesting host element (IfcRelNests / Aggregates inverse)', () => {
    const ds = createGroupDataStore();
    const resolved = resolveMemberGeometry(ds, 201, toLegacyGlobal, GROUP_GEO_IDS);
    assert.deepStrictEqual(resolved, [{ expressId: 202, globalId: 202 }]);
  });

  it('returns [] for a member with no geometry and no resolvable relatives', () => {
    const ds = createGroupDataStore();
    const resolved = resolveMemberGeometry(ds, 999, toLegacyGlobal, GROUP_GEO_IDS);
    assert.deepStrictEqual(resolved, []);
  });
});

describe('groupMatchesSubFilter (#1622)', () => {
  it('buckets the IfcSystem family (incl. IfcDistributionCircuit, IfcStructuralAnalysisModel) as Systems', () => {
    assert.strictEqual(groupMatchesSubFilter('IfcDistributionSystem', 'systems'), true);
    assert.strictEqual(groupMatchesSubFilter('IfcDistributionCircuit', 'systems'), true);
    assert.strictEqual(groupMatchesSubFilter('IfcStructuralAnalysisModel', 'systems'), true);
    assert.strictEqual(groupMatchesSubFilter('IfcZone', 'systems'), false);
  });

  it('buckets IfcZone as Zones and IfcGroup / IfcAsset / IfcInventory as Other', () => {
    assert.strictEqual(groupMatchesSubFilter('IfcZone', 'zones'), true);
    assert.strictEqual(groupMatchesSubFilter('IfcGroup', 'other'), true);
    assert.strictEqual(groupMatchesSubFilter('IfcAsset', 'other'), true);
    assert.strictEqual(groupMatchesSubFilter('IfcInventory', 'other'), true);
    assert.strictEqual(groupMatchesSubFilter('IfcStructuralResultGroup', 'other'), true);
    assert.strictEqual(groupMatchesSubFilter('IfcDistributionCircuit', 'other'), false);
    assert.strictEqual(groupMatchesSubFilter('IfcDistributionSystem', 'other'), false);
  });

  it('passes everything under All', () => {
    for (const t of GROUP_ENTITY_TYPES) {
      assert.strictEqual(groupMatchesSubFilter(t, 'all'), true);
    }
  });
});

describe('buildGroupTree (#1622)', () => {
  it('enumerates concrete subtypes an exact-match IfcSystem query would miss', () => {
    const ds = createGroupDataStore();
    // Guard: the exact-match index really does NOT fold subtypes.
    assert.deepStrictEqual(ds.entityIndex!.byType!.get('IFCSYSTEM'), [500]);
    assert.strictEqual(ds.entityIndex!.byType!.get('IFCDISTRIBUTIONSYSTEM')?.[0], 100);

    const nodes = buildGroupTree(new Map(), ds, new Set(), false, GROUP_GEO_IDS);
    const distSystem = nodes.find((n) => n.type === 'group' && n.ifcType === 'IfcDistributionSystem');
    assert.ok(distSystem, 'the IfcDistributionSystem surfaces despite the exact-match index');
    assert.strictEqual(distSystem.name, 'HVAC System');
  });

  it('surfaces IfcDistributionCircuit and buckets it under the Systems sub-filter', () => {
    const ds = createGroupDataStore();
    // Guard: the circuit is a distinct exact-match bucket, not folded into IfcSystem.
    assert.strictEqual(ds.entityIndex!.byType!.get('IFCDISTRIBUTIONCIRCUIT')?.[0], 600);

    const all = buildGroupTree(new Map(), ds, new Set(), false, GROUP_GEO_IDS);
    const circuit = all.find((n) => n.type === 'group' && n.ifcType === 'IfcDistributionCircuit');
    assert.ok(circuit, 'the IfcDistributionCircuit surfaces despite the exact-match index');
    assert.strictEqual(circuit.name, 'Lighting Circuit');

    // It is a system, so the Systems sub-filter keeps it and Zones drops it.
    const systems = buildGroupTree(new Map(), ds, new Set(), false, GROUP_GEO_IDS, 'systems');
    assert.ok(
      systems.some((n) => n.type === 'group' && n.ifcType === 'IfcDistributionCircuit'),
      'IfcDistributionCircuit passes the Systems sub-filter',
    );
    const zones = buildGroupTree(new Map(), ds, new Set(), false, GROUP_GEO_IDS, 'zones');
    assert.ok(
      !zones.some((n) => n.type === 'group' && n.ifcType === 'IfcDistributionCircuit'),
      'IfcDistributionCircuit is not a zone',
    );
  });

  it('skips a group with zero members', () => {
    const ds = createGroupDataStore();
    const nodes = buildGroupTree(new Map(), ds, new Set(), false, GROUP_GEO_IDS);
    assert.ok(!nodes.some((n) => n.entityExpressId === 500), 'the empty IfcSystem #500 is dropped');
  });

  it('collapses ports into their host element and carries resolved geometry for isolation', () => {
    const ds = createGroupDataStore();
    const nodes = buildGroupTree(new Map(), ds, new Set(['group-legacy-100']), false, GROUP_GEO_IDS);
    const groupNode = nodes.find((n) => n.type === 'group' && n.entityExpressId === 100)!;
    // #100 has 3 members (2 ports + 1 duct) but they resolve to ONE geometry row.
    assert.strictEqual(groupNode.elementCount, 1);
    assert.deepStrictEqual(groupNode.globalIds, [202], 'isolation ids = resolved host geometry only');
    const memberRows = nodes.filter((n) => n.type === 'group-member' && n.id.startsWith('groupmember-legacy-100-'));
    assert.strictEqual(memberRows.length, 1);
    assert.strictEqual(memberRows[0].expressIds[0], 202, 'the duct, not the ports');
  });

  it('keeps a select-only row for a member with no resolvable geometry', () => {
    const ds = createGroupDataStore();
    const nodes = buildGroupTree(new Map(), ds, new Set(['group-legacy-400']), false, GROUP_GEO_IDS);
    const groupNode = nodes.find((n) => n.type === 'group' && n.entityExpressId === 400)!;
    // Duct #202 (geometry) + orphan port #999 (select-only) = 2 rows, but only
    // the duct contributes to isolation geometry.
    assert.strictEqual(groupNode.elementCount, 2);
    assert.deepStrictEqual(groupNode.globalIds, [202]);
    const orphan = nodes.find((n) => n.type === 'group-member' && n.id === 'groupmember-legacy-400-999');
    assert.ok(orphan, 'the geometry-less orphan port stays browsable');
  });

  it('renders the same member under two groups as distinct rows (many-to-many, no dedup)', () => {
    const ds = createGroupDataStore();
    const nodes = buildGroupTree(
      new Map(), ds, new Set(['group-legacy-100', 'group-legacy-400']), false, GROUP_GEO_IDS,
    );
    // Duct #202 belongs to BOTH the HVAC system and the Misc group.
    const rowsFor202 = nodes.filter((n) => n.type === 'group-member' && n.expressIds[0] === 202);
    assert.strictEqual(rowsFor202.length, 2, 'one row per owning group');
    const ids = new Set(rowsFor202.map((n) => n.id));
    assert.strictEqual(ids.size, 2, 'composite ids keep the rows distinct');
    assert.ok(ids.has('groupmember-legacy-100-202'));
    assert.ok(ids.has('groupmember-legacy-400-202'));
  });

  it('falls back to ObjectType for an unnamed group (#1075 display parity)', () => {
    const ds = createGroupDataStore();
    const nodes = buildGroupTree(new Map(), ds, new Set(), false, GROUP_GEO_IDS);
    const zone = nodes.find((n) => n.type === 'group' && n.entityExpressId === 300)!;
    assert.strictEqual(zone.name, 'Fire Compartment');
  });

  it('honours the sub-filter, returning only zones', () => {
    const ds = createGroupDataStore();
    const nodes = buildGroupTree(new Map(), ds, new Set(), false, GROUP_GEO_IDS, 'zones');
    const groups = nodes.filter((n) => n.type === 'group');
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].ifcType, 'IfcZone');
  });

  it('orders systems before zones before generic groups', () => {
    const ds = createGroupDataStore();
    const nodes = buildGroupTree(new Map(), ds, new Set(), false, GROUP_GEO_IDS);
    const order = nodes.filter((n) => n.type === 'group').map((n) => n.ifcType);
    assert.deepStrictEqual(order, [
      'IfcDistributionSystem', 'IfcDistributionCircuit', 'IfcZone', 'IfcGroup',
    ]);
  });
});
