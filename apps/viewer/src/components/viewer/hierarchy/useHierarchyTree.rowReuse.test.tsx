/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10535: a loaded-column edit re-rendered every visible hierarchy row and
 * re-resolved each storey row's membership on every panel render. An edit the
 * tree does not show keeps its rows, a real change still shows, and a storey's
 * members are resolved once per view revision. Real STEP store, real actions.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { cleanup, render } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useHierarchyTree } from './useHierarchyTree';
import type { TreeNode } from './types';

const INITIAL_HIERARCHY_MODE = useViewerStore.getState().hierarchyMode;
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
  useViewerStore.setState({ hierarchyMode: INITIAL_HIERARCHY_MODE });
});

async function mountTree(): Promise<{ tree: () => ReturnType<typeof useHierarchyTree>; view: MutablePropertyView }> {
  const bytes = new TextEncoder().encode(FIXTURE);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const model = { ...fixtureModel(MODEL), ifcDataStore: dataStore } as FederatedModel;
  const view = new MutablePropertyView(dataStore.properties || null, MODEL);
  useViewerStore.setState({
    ...fixtureModels(model), hierarchyMode: 'spatial', loading: false, editEnabled: true,
    mutationViews: new Map([[MODEL, view]]), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(),
    geometryContentVersion: 0, mutationVersion: 0,
  });
  let tree!: ReturnType<typeof useHierarchyTree>;
  function Probe() {
    tree = useHierarchyTree({ models: useViewerStore((s) => s.models), ifcDataStore: null, isMultiModel: false });
    return null;
  }
  render(<Probe />);
  return { tree: () => tree, view };
}

const storeyRow = (rows: readonly TreeNode[]): TreeNode => {
  const row = rows.find((node) => node.type === 'IfcBuildingStorey' && node.expressIds[0] === STOREY);
  assert.ok(row, 'the storey row is visible');
  return row;
};

describe('hierarchy rows across edits (#10535)', () => {
  it('an edit the tree does not show keeps every row, and an edit it shows replaces the storey row', async () => {
    const { tree } = await mountTree();
    const before = tree().treeData;
    const storey = storeyRow(before);

    // A placement-only edit publishes a new mutationVersion and rebuilds the tree from the same data.
    act(() => useViewerStore.setState((s) => ({ mutationVersion: s.mutationVersion + 1 })));
    assert.equal(tree().treeData, before, 'an unchanged rebuild returns the same rows');

    act(() => {
      const added = useViewerStore.getState().addColumn(MODEL, STOREY, { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 });
      assert.ok('expressId' in added, `addColumn failed: ${'error' in added ? added.error : ''}`);
    });
    const after = storeyRow(tree().treeData);
    assert.notEqual(after, storey, 'a storey that gained an element is a new row');
    assert.equal(tree().getNodeElements(after).length, 3, 'the new row resolves the current membership');
  });

  it('resolves a storey row once per view revision, and again after a write that advances it', async () => {
    const { tree, view } = await mountTree();
    const storey = storeyRow(tree().treeData);
    const members = tree().getNodeElements(storey);
    assert.equal(members.length, 2, 'the storey holds both columns');
    assert.equal(tree().getNodeElements(storey), members, 'the panel\'s repeated asks share one resolution');

    // Skip-history and remote writes advance the view revision without a viewer mutationVersion.
    act(() => { view.setProperty(50, 'Pset_Test', 'Note', 'x', undefined, undefined, true); });
    const again = tree().getNodeElements(storey);
    assert.notEqual(again, members, 'a new view revision resolves again');
    assert.deepEqual(again, members);
  });
});
