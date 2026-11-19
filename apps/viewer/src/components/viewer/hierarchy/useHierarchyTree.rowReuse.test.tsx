/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10535: a loaded-column edit re-rendered every visible hierarchy row and
 * re-resolved each storey row's membership on every panel render. Through the
 * hook the panel uses: an edit the tree does not show keeps its row objects
 * (the input the memoized rows compare), a real change still shows, and
 * a storey's members are resolved once per input generation and view
 * revision. Real STEP store, real actions.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { cleanup, render } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { toGlobalIdFromModels } from '@/store/globalId';
import { useHierarchyTree } from './useHierarchyTree';
import type { TreeNode } from './types';

const INITIAL_STATE = useViewerStore.getState();
const MODEL = 'row-reuse';
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
#50=IFCCOLUMN('0aQBAVPOr5VxhS3Jl0O47h',$,'C1',$,$,$,$,$,.COLUMN.);
#51=IFCCOLUMN('0bQBAVPOr5VxhS3Jl0O47h',$,'C2',$,$,$,$,$,.COLUMN.);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#35));
#71=IFCRELAGGREGATES('1kTvXnbbzCWw8lcMd1dR4o',$,$,$,#35,(#36));
#72=IFCRELAGGREGATES('2kTvXnbbzCWw8lcMd1dR4o',$,$,$,#36,(#40));
#80=IFCRELCONTAINEDINSPATIALSTRUCTURE('3kTvXnbbzCWw8lcMd1dR4o',$,$,$,(#50,#51),#40);
ENDSEC;
END-ISO-10303-21;
`;

afterEach(() => {
  cleanup();
  useViewerStore.setState(INITIAL_STATE, true);
});

const meshFor = (globalId: number, x: number) => ({
  expressId: globalId, color: [1, 1, 1, 1], indices: new Uint32Array([0, 1, 2]), normals: new Float32Array(9),
  positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
}) as unknown as MeshData;

const geometryOf = (meshes: MeshData[]) => ({
  meshes, totalTriangles: meshes.length, totalVertices: meshes.length * 3,
  coordinateInfo: {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    hasLargeCoordinates: false,
  },
}) as unknown as GeometryResult;

type Tree = ReturnType<typeof useHierarchyTree>;

async function mountTree(): Promise<{ tree: () => Tree; view: MutablePropertyView; globalOf: (id: number) => number }> {
  const bytes = new TextEncoder().encode(FIXTURE);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const base = { ...fixtureModel(MODEL), ifcDataStore: dataStore } as FederatedModel;
  const globalOf = (id: number) => toGlobalIdFromModels(new Map([[MODEL, base]]), MODEL, id);
  const geometry = geometryOf([meshFor(globalOf(50), 0), meshFor(globalOf(51), 2)]);
  const model = { ...base, geometryResult: geometry } as FederatedModel;
  const view = new MutablePropertyView(dataStore.properties || null, MODEL);
  useViewerStore.setState({
    ...fixtureModels(model), geometryResult: geometry, hierarchyMode: 'spatial', loading: false, editEnabled: true,
    // addColumn caches its StoreEditor into storeEditors in place, and afterEach restores
    // INITIAL_STATE's same Map object, so each test starts from a fresh one.
    mutationViews: new Map([[MODEL, view]]), storeEditors: new Map(),
  });
  let tree!: Tree;
  function Probe() {
    tree = useHierarchyTree({ models: useViewerStore((s) => s.models), ifcDataStore: null, isMultiModel: false });
    return null;
  }
  render(<Probe />);
  return { tree: () => tree, view, globalOf };
}

const storeyRow = (rows: readonly TreeNode[]): TreeNode => {
  const row = rows.find((node) => node.type === 'IfcBuildingStorey' && node.expressIds[0] === STOREY);
  assert.ok(row, 'the storey row is visible');
  return row;
};

describe('hierarchy rows across edits (#10535)', () => {
  it('an edit the tree does not show keeps every row, and an edit it shows replaces the storey row', async () => {
    const { tree, globalOf } = await mountTree();
    const before = tree().treeData;
    const storey = storeyRow(before);

    // A placement edit publishes a new mutationVersion, then its re-mesh swaps the column's mesh:
    // the tree rebuilds from the same data both times.
    act(() => useViewerStore.setState((s) => ({ mutationVersion: s.mutationVersion + 1 })));
    assert.equal(tree().treeData, before, 'an unchanged rebuild returns the same rows');
    act(() => useViewerStore.getState().replaceEntityMeshes(MODEL, new Map([[globalOf(50), [meshFor(globalOf(50), 0.5)]]])));
    assert.equal(tree().treeData, before, 'a mesh swap of an existing element keeps the rows');

    act(() => {
      const added = useViewerStore.getState().addColumn(MODEL, STOREY, { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 });
      assert.ok('expressId' in added, `addColumn failed: ${'error' in added ? added.error : ''}`);
    });
    const after = storeyRow(tree().treeData);
    assert.notEqual(after, storey, 'a storey that gained an element is a new row');
    assert.equal(tree().getNodeElements(after).length, 3, 'the new row resolves the current membership');
  });

  it('resolves a storey row once per input generation and view revision, and again after either changes', async () => {
    const { tree, view } = await mountTree();
    const storey = storeyRow(tree().treeData);
    const members = tree().getNodeElements(storey);
    assert.equal(members.length, 2, 'the storey holds both columns');
    act(() => tree().toggleExpand(storey.id));
    assert.equal(tree().getNodeElements(storey), members, 'another panel render shares the same resolution');
    assert.equal(tree().getNodeElements({ ...storey }), members, 'the cache is keyed by row id, so an equal row object shares it');

    // A skip-history write advances the view's revision without a mutationVersion.
    act(() => { view.setProperty(50, 'Pset_Test', 'Note', 'x', undefined, undefined, true); });
    const again = tree().getNodeElements(storey);
    assert.notEqual(again, members, 'a new view revision resolves again');
    assert.deepEqual(again, members);

    // An edit starts a new input generation, which resolves again too.
    act(() => useViewerStore.setState((st) => ({ mutationVersion: st.mutationVersion + 1 })));
    const nextGeneration = tree().getNodeElements(storey);
    assert.notEqual(nextGeneration, again, 'a new generation resolves again');
    assert.deepEqual(nextGeneration, members);
  });
});
