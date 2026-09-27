/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An element authored in the viewer lives only in the mutation overlay, so
 * the parsed entity table answers `'Unknown'` for its id. The spatial tree
 * read its row label and class from that table and showed a freshly added
 * wall as "Unknown #995 / Unknown" while the Inspector showed "WALL /
 * IfcWall" (#6233). The wall here goes through the real in-store builder
 * action (`addWall`), which also registers the spatial-tree row.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { buildTreeData, buildUnifiedStoreys } from './treeDataBuilder';
import type { TreeNode } from './types';

const MODEL = 'authored-label';
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


async function seed(): Promise<FederatedModel> {
  const bytes = new TextEncoder().encode(FIXTURE);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(dataStore.properties || null, MODEL);
  const geometry = {
    meshes: [], totalTriangles: 0, totalVertices: 0,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      hasLargeCoordinates: false,
    },
  } as unknown as GeometryResult;
  const model = { ...fixtureModel(MODEL), ifcDataStore: dataStore, geometryResult: geometry } as FederatedModel;
  useViewerStore.setState({
    ...fixtureModels(model), geometryResult: geometry, editEnabled: true,
    mutationViews: new Map([[MODEL, view]]), storeEditors: new Map(),
    undoStacks: new Map(), redoStacks: new Map(),
    geometryContentVersion: 0, mutationVersion: 0,
  });
  return model;
}

function addWall(name?: string): number {
  const result = useViewerStore.getState().addWall(MODEL, STOREY, {
    Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3, ...(name ? { Name: name } : {}),
  });
  assert.ok('expressId' in result, `addWall failed: ${'error' in result ? result.error : ''}`);
  return result.expressId;
}

const overlay = (modelId: string) => useViewerStore.getState().mutationViews.get(modelId);

/** The single-model spatial tree, every row expanded. */
function spatialTree(model: FederatedModel): TreeNode[] {
  const expandAll = { has: () => true };
  return buildTreeData(new Map([[MODEL, model]]), null, expandAll, false, [], undefined, undefined, undefined, undefined, overlay);
}

function row(nodes: TreeNode[], expressId: number): TreeNode | undefined {
  return nodes.find((node) => node.type === 'element' && node.expressIds[0] === expressId);
}

describe('spatial tree rows for an element authored this session (#6233)', () => {
  it('labels an added wall with its authored Name and class, not "Unknown"', async () => {
    const model = await seed();
    const wallId = addWall('Authored Wall');

    const node = row(spatialTree(model), wallId);
    assert.ok(node, 'the authored wall has a row under its storey');
    assert.equal(node.name, 'Authored Wall');
    assert.equal(node.ifcType, 'IfcWall');
  });

  it('an unnamed authored wall falls back to "<class> #<id>", never "Unknown #<id>"', async () => {
    const model = await seed();
    const wallId = addWall();
    const node = row(spatialTree(model), wallId);
    assert.ok(node);
    assert.equal(node.ifcType, 'IfcWall');
    assert.doesNotMatch(node.name, /^Unknown/);
  });

  it('a later Name edit reaches the row, as it does in the Inspector', async () => {
    const model = await seed();
    const wallId = addWall('Before');
    useViewerStore.getState().mutationViews.get(MODEL)?.setAttribute(wallId, 'Name', 'After');
    assert.equal(row(spatialTree(model), wallId)?.name, 'After');
  });

  it('the storey badge counts the authored wall as an IfcWall', async () => {
    const model = await seed();
    addWall('Authored Wall');
    const storey = spatialTree(model).find((node) => node.type === 'IfcBuildingStorey');
    assert.equal(storey?.elementCount, 1);
    assert.deepEqual(storey?.countSummary?.typeCounts, [['IfcWall', 1]]);
  });

  it('federated: the unified storey row and its model contribution read the overlay too', async () => {
    const model = await seed();
    const wallId = addWall('Authored Wall');
    const other = { ...model, id: 'other', name: 'Other' } as FederatedModel;
    const models = new Map([[MODEL, model], ['other', other]]);
    const unified = buildUnifiedStoreys(models, undefined, undefined, undefined, undefined, overlay);
    assert.ok(unified[0]?.objects.typeCounts.some(([type]) => type === 'IfcWall'));
    const nodes = buildTreeData(models, null, { has: () => true }, true, unified,
      undefined, undefined, undefined, undefined, overlay);
    const node = nodes.find((n) => n.type === 'element' && n.modelId === MODEL && n.expressIds[0] === wallId);
    assert.equal(node?.name, 'Authored Wall');
    assert.equal(node?.ifcType, 'IfcWall');
  });
});
