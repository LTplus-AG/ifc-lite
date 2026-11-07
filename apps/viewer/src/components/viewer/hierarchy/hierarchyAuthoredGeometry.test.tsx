/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An element authored this session with geometry on screen must not read as
 * shapeless (#9026 item 7). Two different things filed one under the grayed
 * "Other" group: the tree never saw the session's own `IfcRelAggregates`, so a
 * curtain wall, whose meshes all sit on its parts, had "no shape"; and the
 * selector feeding the tree its models compared a re-mesh against a result
 * sharing the same meshes array, so a freshly meshed column looked unchanged
 * and missed the tree's mesh set until the next edit.
 *
 * Everything goes through the real store actions and mesh patch.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { addCurtainWallIn } from '@/store/slices/mutation-curtain-grid';
import { computeModelStats } from '@/components/viewer/properties/modelMetadataStats';
import { cleanup, render } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { toGlobalIdFromModels } from '@/store/globalId';
import { createHierarchyModelsSelector } from './hierarchy-models-selector';
import { buildGeometricIdSet } from './hierarchyGeometry';
import { useHierarchyTree } from './useHierarchyTree';
import { buildTreeData } from './treeDataBuilder';
import { createSpatialSubtreeResolver } from './nodeVisibility';
import type { TreeNode } from './types';

const INITIAL_HIERARCHY_MODE = useViewerStore.getState().hierarchyMode;
const MODEL = 'authored-geometry';
const STOREY = 40;
const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#35=IFCSITE('1hQBAVPOr5VxhS3Jl0O47h',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#36=IFCBUILDING('3hQBAVPOr5VxhS3Jl0O47h',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#40=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,$,$,$,.ELEMENT.,0.);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#35));
#71=IFCRELAGGREGATES('1kTvXnbbzCWw8lcMd1dR4o',$,$,$,#35,(#36));
#72=IFCRELAGGREGATES('2kTvXnbbzCWw8lcMd1dR4o',$,$,$,#36,(#40));
ENDSEC;
END-ISO-10303-21;
`;

const emptyGeometry = () => ({
  meshes: [], totalTriangles: 0, totalVertices: 0,
  coordinateInfo: {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    hasLargeCoordinates: false,
  },
}) as unknown as GeometryResult;

const meshFor = (expressId: number) => ({
  expressId,
  positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array(3),
  color: [1, 1, 1, 1],
}) as unknown as MeshData;

async function seed(): Promise<void> {
  const bytes = new TextEncoder().encode(FIXTURE);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const geometry = emptyGeometry();
  const model = { ...fixtureModel(MODEL), ifcDataStore: dataStore, geometryResult: geometry } as FederatedModel;
  useViewerStore.setState({
    ...fixtureModels(model), geometryResult: geometry, editEnabled: true,
    mutationViews: new Map([[MODEL, new MutablePropertyView(dataStore.properties || null, MODEL)]]),
    storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(),
    geometryContentVersion: 0, mutationVersion: 0,
  });
}

const overlay = (modelId: string) => useViewerStore.getState().mutationViews.get(modelId);
const liveModels = () => useViewerStore.getState().models;
const globalOf = (id: number) => toGlobalIdFromModels(liveModels(), MODEL, id);

/** Give `ids` their meshes the way a finished re-mesh does. */
function deliverMeshes(ids: readonly number[]): void {
  useViewerStore.getState().replaceEntityMeshes(
    MODEL, new Map(ids.map((id) => [globalOf(id), [meshFor(globalOf(id))]])),
  );
}

function spatialTree(models: Map<string, FederatedModel>): TreeNode[] {
  return buildTreeData(
    models, null, { has: () => true }, false, [], undefined,
    buildGeometricIdSet(models, null), new Set([MODEL]), undefined, overlay,
  );
}

function addColumn(): number {
  const result = useViewerStore.getState().addColumn(MODEL, STOREY, {
    Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3,
  });
  assert.ok('expressId' in result, `addColumn failed: ${'error' in result ? result.error : ''}`);
  return result.expressId;
}

function addCurtainWall(): { expressId: number; partIds: readonly number[] } {
  const outcome = addCurtainWallIn(useViewerStore, MODEL, STOREY, {
    Start: [0, 0, 0], End: [6, 0, 0], Height: 3, UGrid: 3, VGrid: 2,
  });
  assert.ok('expressId' in outcome, `addCurtainWall failed: ${'error' in outcome ? outcome.error : ''}`);
  return outcome;
}

afterEach(() => {
  cleanup();
  useViewerStore.setState({ hierarchyMode: INITIAL_HIERARCHY_MODE });
});

describe('hierarchy rows of elements authored with geometry (#9026)', () => {
  it('nests a curtain wall\'s authored parts under a normal row, with no "Other" group', async () => {
    await seed();
    const { expressId, partIds } = addCurtainWall();
    assert.ok(partIds.length > 0);
    deliverMeshes(partIds);

    const nodes = spatialTree(liveModels());
    assert.equal(nodes.find((node) => node.type === 'other-group'), undefined, 'nothing is filed under Other');
    const wall = nodes.find((node) => node.type === 'element' && node.expressIds[0] === expressId);
    assert.ok(wall, 'the curtain wall has a row');
    assert.equal(wall.noGeometry, false);
    assert.equal(wall.ifcType, 'IfcCurtainWall');
    assert.deepEqual(
      new Set(nodes.filter((node) => node.type === 'element' && node.depth === wall.depth + 1).map((node) => node.expressIds[0])),
      new Set(partIds),
      'every part is its child',
    );
    assert.deepEqual(new Set(wall.assemblyChildGlobalIds), new Set(partIds.map(globalOf)), 'the row acts on its parts');
  });

  it('still files a curtain wall under "Other" while none of its parts has a mesh', async () => {
    await seed();
    const { expressId } = addCurtainWall();
    const nodes = spatialTree(liveModels());
    const other = nodes.find((node) => node.type === 'other-group');
    assert.deepEqual(other?.expressIds, [expressId]);
  });

  it('a part deleted later leaves the row', async () => {
    await seed();
    const { expressId, partIds } = addCurtainWall();
    deliverMeshes(partIds);
    overlay(MODEL)?.deleteEntity(partIds[0]);
    const nodes = spatialTree(liveModels());
    const wall = nodes.find((node) => node.expressIds[0] === expressId);
    assert.equal(wall?.assemblyChildGlobalIds?.includes(globalOf(partIds[0])), false);
  });

  it('lists a curtain wall in By Class with its parts as the ids it acts on', async () => {
    await seed();
    const { expressId, partIds } = addCurtainWall();
    deliverMeshes(partIds);
    useViewerStore.setState({ hierarchyMode: 'type' });
    let tree!: ReturnType<typeof useHierarchyTree>;
    function Probe() {
      tree = useHierarchyTree({ models: liveModels(), ifcDataStore: null, isMultiModel: false });
      return null;
    }
    render(<Probe />);
    const group = tree.treeData.find((node) => node.id === 'type-IfcCurtainWall');
    assert.deepEqual(new Set(group?.globalIds), new Set(partIds.map(globalOf)));
    assert.deepEqual(group?.memberGlobalIds, [globalOf(expressId)]);
  });

  it('the storey row\'s subtree holds parts linked only by an authored aggregate', async () => {
    await seed();
    const { partIds } = addCurtainWall();
    // A copied assembly's parts reach their storey through the aggregate alone, not `byStorey`.
    const wall = useViewerStore.getState().addWall(MODEL, STOREY, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    const view = overlay(MODEL)!;
    const part = view.createEntity('IfcBuildingElementPart', []).expressId;
    view.createEntity('IfcRelAggregates', ['0kTvXnbbzCWw8lcMd1dR4p', null, null, null, `#${wall.expressId}`, [`#${part}`]]);
    const storey = spatialTree(liveModels()).find((node) => node.type === 'IfcBuildingStorey');
    assert.ok(storey);
    const subtree = new Set(createSpatialSubtreeResolver(liveModels(), null, overlay)(storey));
    for (const id of [...partIds, part]) assert.ok(subtree.has(globalOf(id)), `part #${id}`);
  });

  it('counts a curtain wall as an element with geometry', async () => {
    await seed();
    const { partIds } = addCurtainWall();
    deliverMeshes(partIds);
    const model = liveModels().get(MODEL)!;
    const stats = computeModelStats(model.ifcDataStore, model.geometryResult, {
      mutationView: overlay(MODEL), geometryReady: true,
      toLocalId: (globalId) => globalId - (model.idOffset ?? 0),
    });
    assert.equal(stats.elementsWithGeometry, partIds.length + 1);
  });

  it('a column leaves "Other" as soon as its mesh lands, on every placement', async () => {
    await seed();
    // The panel's own wiring: the held models selector feeding the tree hook.
    let tree!: ReturnType<typeof useHierarchyTree>;
    function Probe() {
      const [select] = useState(createHierarchyModelsSelector);
      tree = useHierarchyTree({ models: useViewerStore(select), ifcDataStore: null, isMultiModel: false });
      return null;
    }
    render(<Probe />);
    const storey = tree.treeData.find((node) => node.type === 'IfcBuildingStorey');
    assert.ok(storey);
    act(() => tree.toggleExpand(storey.id));

    for (let placed = 1; placed <= 4; placed++) {
      let columnId = 0;
      act(() => { columnId = addColumn(); });
      assert.ok(tree.treeData.some((node) => node.type === 'other-group'), `column ${placed} is shapeless until meshed`);
      act(() => deliverMeshes([columnId]));
      assert.equal(tree.treeData.find((node) => node.type === 'other-group'), undefined, `column ${placed} left Other`);
      assert.equal(tree.treeData.find((node) => node.expressIds[0] === columnId)?.noGeometry, false);
    }
  });
});
